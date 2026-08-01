/**
 * MULTI-SELECTION × TIER-0 EQUATION probe — "a set is not an exception".
 *
 * web/Inspector.svelte states the law beside `eqPaths`: "a multi-selection keeps
 * the universal `=` affordance instead of losing it — Tier 0 says every property
 * is '='-bindable with no exceptions, and a set is not an exception." Two
 * separate defects made that comment false, and this probe is their gate. Both
 * were recorded in the manifest as open before it existed.
 *
 *   D1 — `beginEquation` seeded from a bare `path`, an UNDECLARED identifier
 *        (the parameter is `paths`). Module scope is strict, so every ƒ click on
 *        a color / boolean / select / asset / text row threw ReferenceError —
 *        and threw AFTER `eqOpenKey` was set, so entry opened UNSEEDED and the
 *        thrown error wedged the Svelte flush. Single selection AND multi.
 *   D2 — a MIXED multi-select row rendered the "…" unify button in a branch that
 *        short-circuited the `eqCapable` branch, so ƒ was unreachable on a mixed
 *        row of EVERY kind. Binding a SET to an expression then required unifying
 *        to a LITERAL first and replacing it: two undo units, the first of which
 *        destroyed whatever the items held.
 *   D3 — (reachable only once D2 is fixed) a mixed row whose PRIMARY already
 *        holds an equation must seed entry from that EXPRESSION, not from its
 *        evaluated value. Re-seeding from the evaluated value looks identical on
 *        screen and commits a FROZEN LITERAL, silently deleting the expression.
 *
 * WHY `shadow.color` AND `blendMode`: they are UNIVERSAL EFFECTS BUNDLE rows
 * (core/registry.js withUniversalEffects injects them into every eligible
 * plugin), so they are shared by unrelated widget types BY CONSTRUCTION — which
 * is exactly what makes a heterogeneous intersection rich. `shadow.color` is a
 * non-paint `color` row and `blendMode` is a `select` row, so both are Tier-0
 * slots (EQUATION_KINDS) rather than fields that own their own equation editor.
 *
 * Frontend-only Vite on an EPHEMERAL port. Structural template:
 * tests/multiselect_inspector_probe.js (same deck idiom, same assert helper, same
 * "a pageerror FAILS the probe" rule — an exception inside a Svelte $effect wedges
 * the flush, so every later DOM read silently goes stale).
 *
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/multiselect_equation_probe.js
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

// The two shadow colors the deck starts at — DIFFERENT, so the shared row is
// MIXED and there is a real disagreement for the mark to report.
const SHADOW_PRIMARY = "#ff0000";
const SHADOW_OTHER = "#00ff00";
// The color the joint equation resolves to. Distinct from both above so "did the
// write land" cannot be answered by accident.
const JOINT_COLOR = "#123456";
// The label the shared property registry gives `shadow.color`
// (core/properties.js:1207). Named because three lookups key off it.
const SHADOW_ROW_LABEL = "Shadow color";
const BLEND_ROW_LABEL = "Blend mode";

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  const expand = async () => {
    await page.evaluate(() => {
      for (const h of document.querySelectorAll(".inspector .cat-header"))
        if (h.getAttribute("aria-expanded") === "false") h.click();
    });
    await sleep(400);
  };

  /** Reads one row's value cell: which affordances it renders, and the equation
   *  input's text if it is in entry. Returns {found:false} when the row is not
   *  in the panel, so a missing row reports as itself rather than as a null. */
  const readRow = (label) => page.evaluate((label) => {
    const row = [...document.querySelectorAll(".inspector .row")]
      .find((el) => el.querySelector(".label")?.textContent.trim() === label);
    if (!row) return { found: false };
    return {
      found: true,
      hasEqToggle: !!row.querySelector("button.eq-open"),
      eqPressed: row.querySelector("button.eq-open")?.getAttribute("aria-pressed") ?? null,
      hasUnify: !!row.querySelector("button.mixed-unify"),
      unifyText: row.querySelector("button.mixed-unify")?.textContent.trim() ?? null,
      hasEqInput: !!row.querySelector("input.eq-input"),
      eqText: row.querySelector("input.eq-input")?.value ?? null,
    };
  }, label);

  /** Command. Clicks a row's ƒ toggle. Clicked through the DOM rather than by
   *  coordinate because .eq-open is HOVER-ONLY chrome (zero width at rest, per
   *  app.css) — what is being gated is that the button EXISTS and its handler
   *  does not throw, not the hover reveal, which .row:hover already owns. */
  const clickEqToggle = async (label) => {
    await page.evaluate((label) => {
      const row = [...document.querySelectorAll(".inspector .row")]
        .find((el) => el.querySelector(".label")?.textContent.trim() === label);
      row?.querySelector("button.eq-open")?.click();
    }, label);
    await sleep(500);
  };

  const rawAt = (ids, key) => page.evaluate(({ ids, key }) => {
    const raw = window.__powerrp_app.rawState();
    return ids.map((id) => key.split(".").reduce((o, k) => o?.[k], raw.items?.[id]) ?? null);
  }, { ids, key });

  // ── D1. SINGLE SELECTION: the Tier-0 ƒ opens SEEDED and does not throw ──────
  const single = await page.evaluate((color) => {
    const app = window.__powerrp_app;
    // DESELECT FIRST — a selection surviving clearDoc points at a dead item and
    // the Keyframe Panel throws resolving a plugin for type `undefined`.
    app.selection = null;
    app.clearDoc();
    app.addItem({ ...app.registry.get("rect").defaults, type: "rect", x: 200, y: 200, w: 120, h: 80, shadow: { ...app.registry.get("rect").defaults.shadow, color } });
    return app.selection;
  }, SHADOW_PRIMARY);
  await sleep(800);
  await expand();

  const beforeClick = await readRow(SHADOW_ROW_LABEL);
  assert(beforeClick.found, `the ${SHADOW_ROW_LABEL} row is in the single-selection panel`);
  assert(beforeClick.hasEqToggle, "…and it carries the Tier-0 ƒ toggle");
  assert(!beforeClick.hasEqInput, "…which is not yet in entry");

  await clickEqToggle(SHADOW_ROW_LABEL);
  const opened = await readRow(SHADOW_ROW_LABEL);
  assert(opened.hasEqInput, "D1: clicking ƒ OPENS the equation field (it threw ReferenceError before the fix)");
  assert(opened.eqText === `=${SHADOW_PRIMARY}`,
    `D1: …SEEDED with the row's current value, not blank (${JSON.stringify(opened.eqText)})`);
  // Escape leaves entry without writing, so the deck is untouched for the next part.
  await page.keyboard.press("Escape");
  await sleep(300);
  assert((await rawAt([single], "shadow.color"))[0] === SHADOW_PRIMARY,
    "…and Escape wrote nothing — opening entry is not a document change");

  // ── D2. A MIXED ROW KEEPS THE ƒ ────────────────────────────────────────────
  const pair = await page.evaluate((c) => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    // SPREAD THE PLUGIN DEFAULTS — addItem stores exactly what it is handed, and
    // a widget missing a default reaches the canvas undefined and throws inside
    // an $effect (tests/multiselect_inspector_probe.js records the same trap).
    const add = (type, over) => {
      app.addItem({ ...app.registry.get(type).defaults, type, ...over });
      return app.selection;
    };
    const rectDefaults = app.registry.get("rect").defaults;
    const arrowDefaults = app.registry.get("arrow").defaults;
    const rect = add("rect", { x: 200, y: 200, w: 120, h: 80, shadow: { ...rectDefaults.shadow, color: c.primary } });
    const arrow = add("arrow", { from: { x: 400, y: 120 }, to: { x: 560, y: 260 }, shadow: { ...arrowDefaults.shadow, color: c.other } });
    app.selectMany([rect, arrow]);
    const panel = app.multiSelectPanel();
    return {
      rect, arrow,
      types: app.selectedIds().map((id) => app.rawState().items?.[id]?.type),
      mixed: panel.rows.filter((r) => r.mixed).map((r) => r.row.key),
      keys: panel.rows.map((r) => r.row.key),
    };
  }, { primary: SHADOW_PRIMARY, other: SHADOW_OTHER });
  const both = [pair.rect, pair.arrow];
  await sleep(900);
  await expand();

  assert(JSON.stringify(pair.types) === JSON.stringify(["rect", "arrow"]),
    `precondition: the selection is HETEROGENEOUS (${JSON.stringify(pair.types)})`);
  assert(pair.keys.includes("shadow.color") && pair.keys.includes("blendMode"),
    "precondition: both Tier-0 effect rows are in the intersection");
  assert(pair.mixed.includes("shadow.color"), "precondition: core reports shadow.color as MIXED");

  const mixedRow = await readRow(SHADOW_ROW_LABEL);
  assert(mixedRow.hasUnify && mixedRow.unifyText === "…",
    `the mixed row still shows the unify mark (${JSON.stringify(mixedRow.unifyText)})`);
  assert(mixedRow.hasEqToggle, "D2: …AND the ƒ toggle, which a mixed row used to lose on every kind");
  assert(mixedRow.eqPressed === "false",
    `D2: …unpressed, because a MIXED row is not on one equation (${JSON.stringify(mixedRow.eqPressed)})`);

  // ── D2b. THE ƒ WRITES THE EQUATION TO THE WHOLE SET, IN ONE UNDO UNIT ───────
  await clickEqToggle(SHADOW_ROW_LABEL);
  const inEntry = await readRow(SHADOW_ROW_LABEL);
  assert(inEntry.hasEqInput, "clicking a MIXED row's ƒ opens the equation field");
  assert(!inEntry.hasUnify, "…and the mark stands down while the field is open (one control at a time)");
  assert(inEntry.eqText === `=${SHADOW_PRIMARY}`,
    `…seeded from the PRIMARY, the same value a unify would write (${JSON.stringify(inEntry.eqText)})`);

  const beforeJoint = await rawAt(both, "shadow.color");
  assert(JSON.stringify(beforeJoint) === JSON.stringify([SHADOW_PRIMARY, SHADOW_OTHER]),
    `precondition: the two really differ (${JSON.stringify(beforeJoint)})`);
  // ONLY TYPE INTO A FIELD THAT IS ACTUALLY THERE. With the field absent (the
  // defect this gates) the keystrokes would reach the app's SHORTCUT REGISTRY
  // instead — which mutates the deck, and every later assertion then measures the
  // damage rather than the defect. Proved: the first run of this probe at HEAD
  // inserted a typeless item and buried the real reds under three
  // `Unknown widget type "undefined"` page errors. The read-back assertions below
  // still fail on the unchanged values, which is the red the gate is for.
  if (inEntry.hasEqInput) {
    // The field autofocuses with its text SELECTED (eqAutofocus), so typing replaces.
    await page.keyboard.type(`=${JOINT_COLOR}`);
    await sleep(250);
    await page.keyboard.press("Enter");
    await sleep(700);
  }

  const jointStored = await rawAt(both, "shadow.color");
  assert(jointStored.every((v) => v === `=${JOINT_COLOR}`),
    `D2: ONE equation reached BOTH items as an EQUATION, not as a literal (${JSON.stringify(jointStored)})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(600);
  assert(JSON.stringify(await rawAt(both, "shadow.color")) === JSON.stringify(beforeJoint),
    "D2: ONE undo reverted BOTH — the joint equation write is ONE undo unit");
  assert((await page.evaluate(() => window.__powerrp_app.selectedIds().length)) === 2,
    "…and the multi-selection survived the undo");

  // ── D3. THE SEED KEEPS THE PRIMARY'S EXPRESSION ────────────────────────────
  // The primary holds an equation REFERENCING the other item; the other holds a
  // literal. That makes the row MIXED with an equation on the primary — the one
  // arrangement single selection can never produce (there, ƒ is a DROP button
  // once a row renders as an equation, so entry is unreachable). A reference is
  // used deliberately: a color-literal equation's display form and its seeded
  // form are the same characters, so it could not tell the two behaviours apart.
  await page.evaluate((p) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", p.rect, "blendMode"], `=@${p.arrow}.blendMode`], [["items", p.arrow, "blendMode"], "multiply"]]);
    app.commitPreview();
  }, pair);
  await sleep(700);
  await expand();

  const blendMixed = await page.evaluate(() =>
    window.__powerrp_app.multiSelectPanel().rows.filter((r) => r.mixed).map((r) => r.row.key));
  assert(blendMixed.includes("blendMode"),
    "precondition: an equation on the primary and a literal on the other reads as MIXED");

  await clickEqToggle(BLEND_ROW_LABEL);
  const seeded = await readRow(BLEND_ROW_LABEL);
  assert(seeded.hasEqInput, "D3: the ƒ opens on a mixed row whose primary already holds an equation");
  assert(seeded.eqText != null && seeded.eqText !== '="multiply"' && seeded.eqText !== '="normal"',
    `D3: …seeded with the EXPRESSION, not with its frozen evaluated value (${JSON.stringify(seeded.eqText)})`);
  assert(seeded.eqText != null && /blend_?mode/i.test(seeded.eqText),
    `D3: …and the expression is the stored one, in display form (${JSON.stringify(seeded.eqText)})`);
  await page.keyboard.press("Escape");
  await sleep(300);
  assert((await rawAt([pair.rect], "blendMode"))[0] === `=@${pair.arrow}.blendMode`,
    "D3: …and Escape left the primary's equation exactly as stored");

  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nPASS — the Tier-0 equation reaches a heterogeneous set");
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
