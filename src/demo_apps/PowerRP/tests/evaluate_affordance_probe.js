/**
 * THE EVALUATE ("1 2 3") BUTTON — browser probe (WORKSTREAM AD).
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/evaluate_affordance_probe.js
 *
 * The VALUE rule is pinned bare-node in tests/evaluate_literal_test.js. This
 * probe pins the half only a real browser can answer — that the button EXISTS
 * where the user said it should and nowhere else — against the REAL editor:
 *   - a LITERAL row shows ƒ (mdi:function-variant) in the slot, and no "1 2 3";
 *   - an EQUATION row shows "1 2 3" (mdi:numeric) in that SAME slot, and no ƒ
 *     — the mutual exclusion is structural, so both halves are checked;
 *   - clicking it bakes the DISPLAYED value as a literal, in ONE undo unit,
 *     and the row goes back to its number scrubber;
 *   - ƒ RETURNS afterwards (the round trip is closed, not one-way);
 *   - an ERRORING equation's button is aria-disabled and carries the REASON
 *     rather than the promise, and clicking it writes NOTHING.
 *
 * THE ROW UNDER TEST IS X, WHICH IS NO LONGER A TOP-LEVEL ROW. Commit 15a7d333
 * grouped `x`/`y` under a "Position" compound that is COLLAPSED at rest, so the
 * probe opens that disclosure first (see openCompound). The requirement being
 * pinned did not change — only where the row is reached from.
 *
 * The icon is asserted by NAME (the <iconify-icon icon="…"> attribute) rather
 * than by pixels: an icon that does not exist in the set renders an EMPTY
 * button with no build error (the 3e79a24 bug), so a screenshot would look
 * "fine" either way while the attribute is the thing that was verified against
 * the Iconify API.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

// Known boot noise, shared verbatim with equation_discoverability_probe.js —
// repair reports, missing fonts, the legacy duration/transition migration, and
// this container's headless graphics reality (no GPU adapter). Named
// specifically: the gate still fails on anything else.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// The ERRORING-EQUATION check deliberately puts a reference to a nonexistent
// property into the document, so core's OWN evaluation error is the EXPECTED
// result of that step, not a probe failure — it is the very condition the
// disabled button reports. Routed to its own bucket (still printed) by message
// shape; anything else still fails the probe.
const isExpectedEvalNoise = (s) => /PowerRP expression error at items\..*(has no property|is not a numeric property|Unknown variable)/.test(s);

const expectedNoise = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (isExpectedEvalNoise(text)) expectedNoise.push(text);
    else errors.push(`console.error: ${text}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  if (errors.length) console.warn("(ignoring boot noise:\n  " + errors.join("\n  ") + "\n)");
  errors.length = 0; // from here, ANY unexpected console error fails the probe

  // ── A plain rect, so the row under test is the ORDINARY numeric row ────────
  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.addItem({ ...app.registry.get("rect").defaults, x: 100, y: 100, w: 200, h: 120 });
    return app.selection;
  });
  ok(rectId, "rect created + selected");
  await new Promise((r) => setTimeout(r, 250));

  const findRow = (label) => `[...document.querySelectorAll(".inspector .row")].find(r => r.querySelector(".label")?.textContent === ${JSON.stringify(label)})`;

  /** Query. The icon NAMES rendered in a row's ƒ/Evaluate slot (.eq-open). */
  async function slotIcons(label) {
    return page.evaluate((expr) => {
      const row = eval(expr);
      if (!row) return null;
      return [...row.querySelectorAll(".eq-open iconify-icon")].map((i) => i.getAttribute("icon"));
    }, findRow(label));
  }

  /** Command. Writes a stored value straight into the document at the row's
   * path — the row's own equation editor is exercised by
   * equation_discoverability_probe.js; THIS probe is about what the SLOT
   * renders once a value is stored, so it sets the value the short way. */
  async function storeValue(key, value) {
    await page.evaluate((id, k, v) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, k], v]]);
      app.commitPreview();
    }, rectId, key, value);
    await new Promise((r) => setTimeout(r, 200));
  }

  /**
   * Command. Opens a COMPOUND row's disclosure so its LEAF rows render as
   * ordinary rows, and fails loudly if the disclosure is not there.
   *
   * WHY THIS EXISTS — THE OLD SPELLING AND THE NEW ONE. `X` was a top-level
   * Inspector row when this probe was written. Commit 15a7d333 ("Compound
   * property rows: XY and WH group over their own leaves") made `x` and `y`
   * LEAVES of a "Position" compound (core/properties.js COMPOUNDS.xy) that is
   * CLOSED at rest, so `findRow("X")` returned undefined and this probe crashed
   * with a TypeError before its first assertion — a stale SPELLING, not a broken
   * product.
   *
   * THE REQUIREMENT IS UNCHANGED and is still asserted against the same row: an
   * ordinary numeric row carries ƒ while it holds a literal and "1 2 3" while it
   * holds an equation, one slot, mutually exclusive. So the probe opens the
   * compound rather than being weakened to accept whatever the collapsed row
   * happens to render inline.
   *
   * Clicked through the row's OWN twisty rather than by seeding the
   * `powerrp.inspectorCompoundOpen` localStorage key, because the disclosure a
   * user would use is the one the probe should use — and because a renamed
   * storage key would silently leave the compound shut, while a moved twisty
   * throws here with a sentence naming what moved.
   */
  async function openCompound(label) {
    const found = await page.evaluate((expr) => {
      const twisty = eval(expr)?.querySelector(".compound-twisty");
      if (!twisty) return false;
      if (twisty.getAttribute("aria-expanded") !== "true") twisty.click();
      return true;
    }, findRow(label));
    if (!found) throw new Error(`no compound row labelled "${label}" carrying a .compound-twisty — the Inspector's compound disclosure moved`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // ── A LITERAL row shows ƒ, and NOT the "1 2 3" button ──────────────────────
  // X lives inside the "Position" compound since 15a7d333; open it so the row
  // under test is present (see openCompound).
  await openCompound("Position");
  ok(await page.evaluate((expr) => !!eval(expr), findRow("X")),
    "the X leaf row renders once its Position compound is open");
  const literalIcons = await slotIcons("X");
  ok(literalIcons?.includes("mdi:function-variant"), `literal row shows the ƒ button; got ${JSON.stringify(literalIcons)}`);
  ok(!literalIcons?.includes("mdi:numeric"), `literal row does NOT show the "1 2 3" button (the user's "you only see that when it is an equation"); got ${JSON.stringify(literalIcons)}`);

  // ── An EQUATION row swaps the slot: "1 2 3" in, ƒ out ──────────────────────
  // 40 + 2.5 = 42.5, chosen so the baked literal proves the EVALUATED tree was
  // read (the stored value is the expression text) and is not a round number
  // that could be mistaken for a default.
  await storeValue("x", "=40 + 2.5");
  const eqIcons = await slotIcons("X");
  ok(eqIcons?.includes("mdi:numeric"), `equation row shows the "1 2 3" button (mdi:numeric — verified present in the Iconify set); got ${JSON.stringify(eqIcons)}`);
  ok(!eqIcons?.includes("mdi:function-variant"), `equation row does NOT also show ƒ — one slot, one button; got ${JSON.stringify(eqIcons)}`);

  const eqTip = await page.evaluate((expr) => eval(expr)?.querySelector(".eq-open")?.getAttribute("aria-label"), findRow("X"));
  ok(/discarded/.test(eqTip ?? ""), `the button says the expression is DISCARDED; got ${JSON.stringify(eqTip)}`);
  ok(/across slides/.test(eqTip ?? ""), `...and warns that a slide-varying value becomes fixed; got ${JSON.stringify(eqTip)}`);
  ok(await page.evaluate((expr) => eval(expr)?.querySelector(".eq-open")?.getAttribute("aria-disabled") !== "true", findRow("X")),
    "a HEALTHY equation's button is enabled");

  // ── Clicking it bakes the displayed value, in ONE undo unit ────────────────
  const undoDepthBefore = await page.evaluate(() => window.__powerrp_app.undoDepth?.() ?? null);
  await page.evaluate((expr) => eval(expr).querySelector(".eq-open").click(), findRow("X"));
  await new Promise((r) => setTimeout(r, 250));

  const bakedStored = await page.evaluate((id) => window.__powerrp_app.rawState().items[id].x, rectId);
  ok(bakedStored === 42.5, `clicking bakes the EVALUATED value as a literal number; stored is now ${JSON.stringify(bakedStored)}`);
  ok(typeof bakedStored === "number", `...a NUMBER, not the expression text (the evaluated tree was read, not the stored one); got ${typeof bakedStored}`);

  // ── ƒ RETURNS: the round trip is closed ────────────────────────────────────
  const afterIcons = await slotIcons("X");
  ok(afterIcons?.includes("mdi:function-variant"), `ƒ returns after baking — the row is a literal again; got ${JSON.stringify(afterIcons)}`);
  ok(!afterIcons?.includes("mdi:numeric"), `...and the "1 2 3" button is gone; got ${JSON.stringify(afterIcons)}`);
  ok(await page.evaluate((expr) => !!eval(expr)?.querySelector(".numfield .dn"), findRow("X")),
    "the number scrubber is back (\"back into number mode\")");

  // ONE undo unit: a single undo restores the EXPRESSION verbatim.
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 250));
  const afterUndo = await page.evaluate((id) => window.__powerrp_app.rawState().items[id].x, rectId);
  ok(afterUndo === "=40 + 2.5", `ONE undo restores the equation verbatim; got ${JSON.stringify(afterUndo)}`);
  if (undoDepthBefore != null) {
    const depthNow = await page.evaluate(() => window.__powerrp_app.undoDepth?.() ?? null);
    ok(depthNow === undoDepthBefore, `...and exactly one entry was consumed (${undoDepthBefore} → ${depthNow})`);
  }

  // ── AN ERRORING EQUATION IS REFUSED, with the reason ───────────────────────
  // A reference to a property that does not exist: core reports it (the
  // expected-noise bucket) and falls back, which is precisely why baking must
  // be refused — it would stamp that fallback over the only record of intent.
  await storeValue("x", "=self.no_such_property + 1");
  const errIcons = await slotIcons("X");
  ok(errIcons?.includes("mdi:numeric"), `an ERRORING equation still shows the button (so its reason is reachable); got ${JSON.stringify(errIcons)}`);
  const errBtn = await page.evaluate((expr) => {
    const b = eval(expr)?.querySelector(".eq-open");
    return b ? { disabled: b.getAttribute("aria-disabled"), label: b.getAttribute("aria-label"), native: b.disabled } : null;
  }, findRow("X"));
  ok(errBtn?.disabled === "true", `the erroring row's button is aria-disabled; got ${JSON.stringify(errBtn?.disabled)}`);
  ok(errBtn?.native === false, "...via aria-disabled, NOT the native attribute — so the keyboard can still reach the reason");
  ok(/error/.test(errBtn?.label ?? "") && /fallback/.test(errBtn?.label ?? ""),
    `...and it carries the REASON (naming the fallback) instead of the promise; got ${JSON.stringify(errBtn?.label)}`);

  // Clicking it must write NOTHING — the handler guard, not just the styling.
  await page.evaluate((expr) => eval(expr).querySelector(".eq-open").click(), findRow("X"));
  await new Promise((r) => setTimeout(r, 250));
  const afterBadClick = await page.evaluate((id) => window.__powerrp_app.rawState().items[id].x, rectId);
  ok(afterBadClick === "=self.no_such_property + 1",
    `clicking the disabled button writes NOTHING — the equation survives; got ${JSON.stringify(afterBadClick)}`);

  // ── Report ─────────────────────────────────────────────────────────────────
  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Evaluate affordance probe passed: ${checks.length}/${checks.length} checks, zero UNEXPECTED console errors ` +
    `(${expectedNoise.length} expected evaluation errors from the deliberate broken-equation step).`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
