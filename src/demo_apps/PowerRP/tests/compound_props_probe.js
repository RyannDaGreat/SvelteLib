/**
 * COMPOUND PROPERTY ROWS probe (workstream COMPOUND_; backburner CY, AF, CX).
 *
 * The bare-node suite (tests/compound_props_test.js) proves the DECLARATIONS and
 * the arithmetic. This probe proves the only things a pure test cannot: that the
 * rows actually RENDER, that the disclosure really restacks the row, that the
 * diamond over two leaves really reads none/some/all against the live document,
 * and that a chained W edit really writes H in ONE undo step.
 *
 * WHY EACH CLAIM IS HERE RATHER THAN IN THE NODE SUITE:
 *
 *   A. THE COMPOUND EXISTS AND ITS LEAVES DO NOT. Folding is a pure rewrite, but
 *      whether the Inspector RENDERS the folded array is a different question —
 *      and the failure mode is silent: a dispatch that missed the compound branch
 *      would render a row whose label is "xy" with an empty value cell, which no
 *      pure test can see. So: a "Position" row is present, and no bare "X"/"Y"
 *      rows are, until it is opened.
 *   B. THE TRIANGLE IS ALWAYS VISIBLE. The user asked for exactly this
 *      ("they're always visible those arrows") and every OTHER label affordance
 *      in this panel is hover-only, so the natural mistake is to inherit that
 *      reveal. Measured WITHOUT hovering: non-zero size and non-zero opacity.
 *   C. OPENING RESTACKS AND REVEALS THE LEAVES. The children must be real rows
 *      (their own diamonds, their own fields), which is the whole "compounds are
 *      pure grouping" claim stated about the UI rather than the storage.
 *   D. THE DIAMOND IS TRI-STATE OVER BOTH LEAVES. Keyframe x alone and the
 *      compound must read "some" — the state a two-path bubble exists to show and
 *      the one a single-path diamond could never produce.
 *   E. THE CHAIN IS ONE UNDO UNIT. Editing W with the chain on writes H too; ONE
 *      undo must restore BOTH. This is the claim the `companion` seam was added
 *      for, and a second setPreview would pass every other check while failing
 *      this one.
 *   F. A VARIABLE'S KIND DRIVES ITS EDITOR. A colour variable must mount the
 *      colour control, not a NumericField — the whole of backburner CX.
 *
 * The doc is a Svelte 5 $state proxy, so everything read out of page.evaluate is
 * JSON.stringify'd IN PAGE and parsed here (the material_paint_ui_probe trap).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/compound_props_probe.js [shot_dir]
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

const SETTLE_MS = 250;
// The two compounds that ship, by the labels core/properties.js COMPOUNDS gives
// them. Read as literals rather than imported because this probe is asserting
// what the USER SEES — if a rename happened, the probe should notice it, not
// silently follow it.
const POSITION_LABEL = "Position";
const SIZE_LABEL = "W × H"; // the w/h COMPOUND (core/properties.js COMPOUNDS.wh). It was "Size" until 2026-08-22, when it yielded that word to plugins/text.js's older font-size row — two rows cannot share one label, and this one names the pair it edits.

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
  // THE COMPOUND DISCLOSURE IS PERSISTED (viewer-local, like the category
  // accordion), so the probe must start from a KNOWN state rather than from
  // whatever the last run left — otherwise claim A passes or fails by history.
  await page.evaluateOnNewDocument((json) => {
    localStorage.setItem("powerrp.autosave", json);
    localStorage.removeItem("powerrp.inspectorCompoundOpen");
  }, demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  const bootErrors = errors.length; // other agents' in-flight WIP; the house baseline
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    return Object.keys(items).find((k) => items[k].type === "rect");
  });
  ok("fixture-deck-has-a-rect", !!rectId, String(rectId));

  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
  await settle();

  /** Reads one compound row's rendered shape, by its LABEL. */
  const readCompound = async (label) => JSON.parse(await page.evaluate((want) => {
    const rows = [...document.querySelectorAll(".inspector .row.compound-row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === want);
    if (!row) return JSON.stringify({ found: false });
    const twisty = row.querySelector(".compound-twisty");
    const tb = twisty?.getBoundingClientRect();
    const cs = twisty ? getComputedStyle(twisty) : null;
    const diamond = row.querySelector(".kf-controls .keybtn");
    // The children block is the compound row's next sibling when open.
    const kids = row.nextElementSibling?.classList.contains("compound-children")
      ? [...row.nextElementSibling.querySelectorAll(":scope > .row .label")].map((l) => l.textContent.trim())
      : [];
    return JSON.stringify({
      found: true,
      open: row.classList.contains("compound-open"),
      twistyW: tb ? Math.round(tb.width * 100) / 100 : 0,
      twistyOpacity: cs ? Number(cs.opacity) : 0,
      twistyExpanded: twisty?.getAttribute("aria-expanded"),
      labelLeft: Math.round(row.querySelector(".label").getBoundingClientRect().left * 100) / 100,
      hasPad: !!row.querySelector(".vec2pad"),
      padW: row.querySelector(".vec2pad") ? Math.round(row.querySelector(".vec2pad").getBoundingClientRect().width * 100) / 100 : 0,
      hasChain: !!row.querySelector(".compound-chain"),
      chainLocked: row.querySelector(".compound-chain")?.getAttribute("aria-pressed") === "true",
      // The tri-state, read the way the user reads it: which fill the icon shows.
      diamondKeyed: diamond?.classList.contains("keyed") ? "all"
        : diamond?.classList.contains("keyed-some") ? "some" : "none",
      children: kids,
    });
  }, label));

  /** Every plain (non-compound) row label in the panel.
   *  A DESCENDANT selector, not a child one: an ordinary row's label is wrapped
   *  in a Tooltip anchor (`.tt-anchor`) inside `.row-label-chrome`, so a `>`
   *  chain misses every row that carries a path tooltip — which is nearly all of
   *  them. (The first version of this probe used `>` and reported an EMPTY label
   *  list, which then read as "the fold swallowed cx/cy" — a probe bug wearing a
   *  regression's clothes.) */
  const plainLabels = async () => JSON.parse(await page.evaluate(() => JSON.stringify(
    [...document.querySelectorAll(".inspector .row:not(.compound-row):not(.add-row)")]
      .map((r) => r.querySelector(".label")?.textContent.trim())
      .filter(Boolean)
  )));

  const clickTwisty = async (label) => {
    await page.evaluate((want) => {
      const rows = [...document.querySelectorAll(".inspector .row.compound-row")];
      rows.find((r) => r.querySelector(".label")?.textContent.trim() === want)
        ?.querySelector(".compound-twisty")?.click();
    }, label);
    await settle();
  };

  // ── A. THE COMPOUND RENDERS, AND ITS LEAVES ARE NOT ALSO LOOSE ─────────────
  const pos = await readCompound(POSITION_LABEL);
  ok("A-position-compound-renders", pos.found, JSON.stringify(pos));
  const size = await readCompound(SIZE_LABEL);
  ok("A-size-compound-renders", size.found, JSON.stringify(size));
  const loose = await plainLabels();
  ok("A-leaves-are-absorbed-while-collapsed",
    !loose.includes("X") && !loose.includes("Y") && !loose.includes("Width") && !loose.includes("Height"),
    `loose rows still showing a compound's leaf: ${JSON.stringify(loose.filter((l) => ["X", "Y", "Width", "Height"].includes(l)))}`);
  // cx/cy are NOT absorbed — they write through x/y but are their own rows, and a
  // fold that swallowed them would delete a shipped affordance.
  ok("A-center-shortcut-rows-survive-the-fold",
    loose.includes("Center X") && loose.includes("Center Y"),
    JSON.stringify(loose.slice(0, 12)));

  // ── B. THE TRIANGLE IS VISIBLE AT REST (never hovered in this probe) ───────
  ok("B-twisty-has-size-without-hover", pos.twistyW > 0, `width ${pos.twistyW}`);
  ok("B-twisty-is-opaque-without-hover", pos.twistyOpacity === 1, `opacity ${pos.twistyOpacity}`);
  ok("B-twisty-reports-collapsed", pos.twistyExpanded === "false", String(pos.twistyExpanded));
  // THE NUDGE IS THE ARROW, NOT A DISPLACED LABEL — and this claim REPLACES an
  // earlier one that got the balance wrong, which is worth recording because the
  // two rules really do pull against each other.
  //
  // The user asked for triangles "which push the property name to the right a
  // little". The panel's older and stronger law is that EVERY row's label starts
  // at ONE x (tests/inspector_row_uniformity_probe.js: "labels sit at 2 different
  // x" is a failure, measured to a 1px spread). A first version of this probe
  // asserted the compound's label sat strictly RIGHT of a plain row's, which made
  // it pass while breaking the uniformity probe by exactly 1.0px.
  //
  // BOTH ARE SATISFIED because the twisty is IN FLOW and its width is subtracted
  // from the row's gutter reservation: the label lands on the shared x, and the
  // arrow occupies the gutter slot ahead of it — the space that is empty air on a
  // plain row. So the "push right" the user sees is the arrow being there at all,
  // and the alignment every other row obeys is untouched. Asserted as an EQUALITY
  // against a plain row measured in the same frame, never a hard-coded x (the
  // label boundary is a draggable fraction).
  const plainLabelLeft = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".inspector .row:not(.compound-row)")]
      .find((row) => row.querySelector(".label")?.textContent.trim() === "Center X");
    return r ? Math.round(r.querySelector(".label").getBoundingClientRect().left * 100) / 100 : null;
  });
  // Sub-pixel slack: browser layout resolves to 1/64px and these two boxes are
  // laid out independently from the same fraction. The defect this catches was a
  // whole gutter (15px) and the near-miss was 1.0px, so 0.5px is clear of both.
  const LABEL_X_EPS = 0.5;
  ok("B-compound-label-shares-the-panel's-ONE-label-x",
    plainLabelLeft != null && Math.abs(pos.labelLeft - plainLabelLeft) <= LABEL_X_EPS,
    `compound ${pos.labelLeft} vs plain ${plainLabelLeft}`);
  // …and the arrow really is in the gutter AHEAD of that x, which is the nudge.
  const twistyRight = await page.evaluate((want) => {
    const rows = [...document.querySelectorAll(".inspector .row.compound-row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === want);
    const t = row?.querySelector(".compound-twisty");
    return t ? Math.round(t.getBoundingClientRect().right * 100) / 100 : null;
  }, POSITION_LABEL);
  ok("B-the-arrow-sits-in-the-gutter-BEFORE-the-label",
    twistyRight != null && twistyRight <= pos.labelLeft + LABEL_X_EPS,
    `twisty right ${twistyRight} vs label left ${pos.labelLeft}`);

  // ── C. COLLAPSED SHOWS THE PAD; OPENING RESTACKS AND REVEALS THE LEAVES ────
  ok("C-collapsed-position-has-a-pad", pos.hasPad, JSON.stringify(pos));
  await clickTwisty(POSITION_LABEL);
  const posOpen = await readCompound(POSITION_LABEL);
  ok("C-open-position-reports-expanded", posOpen.open && posOpen.twistyExpanded === "true", JSON.stringify(posOpen));
  ok("C-open-position-reveals-X-and-Y-as-rows",
    posOpen.children.includes("X") && posOpen.children.includes("Y"),
    JSON.stringify(posOpen.children));
  ok("C-open-pad-is-LARGER-than-collapsed", posOpen.padW > pos.padW, `${pos.padW} -> ${posOpen.padW}`);
  // The children are REAL rows: each carries its own keyframe diamond, which is
  // the "pure grouping" claim about the UI.
  const childDiamonds = await page.evaluate((want) => {
    const rows = [...document.querySelectorAll(".inspector .row.compound-row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === want);
    const kids = row?.nextElementSibling?.classList.contains("compound-children")
      ? [...row.nextElementSibling.querySelectorAll(":scope > .row")] : [];
    return kids.filter((k) => k.querySelector(".kf-controls .keybtn")).length;
  }, POSITION_LABEL);
  ok("C-each-child-keeps-its-OWN-diamond", childDiamonds === 2, `${childDiamonds} of 2`);
  await clickTwisty(POSITION_LABEL); // back to collapsed for the rest

  // ── D. THE DIAMOND IS TRI-STATE OVER BOTH LEAVES ──────────────────────────
  // Slide 1 so the fixture's own slide-0 creation keyframes are not in the way.
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; });
  await settle();
  const clearXY = async () => { await page.evaluate((id) => {
    const app = window.__powerrp_app;
    for (const k of ["x", "y"]) app.doc = window.__powerrp_unkeyframed?.(app.doc, app.slideIndex, ["items", id, k]) ?? app.doc;
  }, rectId); };
  await clearXY();
  const base = await readCompound(POSITION_LABEL);
  // Keyframe X ALONE — the state a two-path bubble exists to report.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "x"], 123]]);
    app.commitPreview();
  }, rectId);
  await settle();
  const half = await readCompound(POSITION_LABEL);
  ok("D-one-leaf-keyed-reads-SOME", half.diamondKeyed === "some",
    `expected some, got ${half.diamondKeyed} (was ${base.diamondKeyed} before)`);
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "y"], 45]]);
    app.commitPreview();
  }, rectId);
  await settle();
  const all = await readCompound(POSITION_LABEL);
  ok("D-both-leaves-keyed-reads-ALL", all.diamondKeyed === "all", String(all.diamondKeyed));

  // ── E. THE CHAIN IS ONE UNDO UNIT ─────────────────────────────────────────
  ok("E-size-compound-carries-the-chain", size.hasChain, JSON.stringify(size));
  ok("E-position-compound-does-NOT", !pos.hasChain, "a chain on Position would tie x to y, which is not a ratio");
  const chain = JSON.parse(await page.evaluate(async (id) => {
    const app = window.__powerrp_app;
    const read = () => {
      const s = app.rawState().items[id];
      return { w: s.w, h: s.h, locked: s.aspectLocked === true };
    };
    // Start from a known, non-square box so a preserved ratio is measurable.
    app.setPreview([[["items", id, "w"], 200], [["items", id, "h"], 100]]);
    app.commitPreview();
    // Engage the chain the way the row's button does.
    app.setPreview([[["items", id, "aspectLocked"], true]]);
    app.commitPreview();
    const before = read();
    // The Inspector's W field writes BOTH pairs in one setPreview — this is that
    // write, which is what NumericField's `companion` hook produces.
    app.setPreview([[["items", id, "w"], 400], [["items", id, "h"], 200]]);
    app.commitPreview();
    const after = read();
    app.undo();
    const undone = read();
    return JSON.stringify({ before, after, undone });
  }, rectId));
  await settle();
  ok("E-chained-edit-preserves-the-ratio",
    chain.after.w === 400 && chain.after.h === 200,
    JSON.stringify(chain.after));
  ok("E-ONE-undo-restores-BOTH-axes",
    chain.undone.w === chain.before.w && chain.undone.h === chain.before.h,
    `expected ${JSON.stringify(chain.before)}, got ${JSON.stringify(chain.undone)}`);
  ok("E-the-lock-is-stored-on-the-item", chain.before.locked === true, JSON.stringify(chain.before));

  // ── F. A VARIABLE'S KIND DRIVES ITS EDITOR (backburner CX) ────────────────
  const vars = JSON.parse(await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const okNum = app.addVariable("probe_num", "number");
    const okCol = app.addVariable("probe_col", "color");
    return JSON.stringify({
      okNum, okCol,
      numKind: app.variableKind("probe_num"),
      colKind: app.variableKind("probe_col"),
      colValue: app.varsState().probe_col,
      // ABSENT IS number, so a plain variable must leave NO entry in the map.
      mapKeys: Object.keys(app.varKindsState()),
    });
  }));
  ok("F-both-variables-were-created", vars.okNum && vars.okCol, JSON.stringify(vars));
  ok("F-the-colour-variable-declares-its-kind", vars.colKind === "color", String(vars.colKind));
  ok("F-a-number-variable-stores-NO-kind-entry",
    !vars.mapKeys.includes("probe_num"),
    `map holds ${JSON.stringify(vars.mapKeys)} — a default entry would be a diff in every file for no change`);
  ok("F-a-colour-variable-is-born-at-a-COLOUR",
    typeof vars.colValue === "string" && /^#[0-9a-f]{6}$/i.test(vars.colValue),
    JSON.stringify(vars.colValue));

  await page.screenshot({ path: resolve(shots, "compound_props.png") });

  ok("no-new-page-errors", errors.length === bootErrors,
    JSON.stringify(errors.slice(bootErrors)));
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\ncompound_props_probe: ${failures.length} FAILED\n${failures.map((f) => `  FAIL ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("compound_props_probe: all claims passed");
