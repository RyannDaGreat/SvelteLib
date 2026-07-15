/**
 * Equation discoverability probe (SonnetA5): boot the PowerRP editor headless,
 * add a Fancy Arrow (the user's EXACT complaint case — a widget with
 * camelCase-keyed properties, startWidth/endWidth), and exercise the full
 * canonical-grammar package end-to-end through the REAL app:
 *   - hovering a property row's LABEL shows the canonical equation path
 *     (self.<snake_case>) via the Tooltip component — never a label echo;
 *   - the row's copy-path icon copies the ABSOLUTE canonical path;
 *   - typing a snake_case equation ("self.start_width + 2") into the
 *     End Width field commits and evaluates correctly against the item's
 *     REAL camelCase-keyed property (startWidth);
 *   - the autocomplete dropdown, triggered by typing "self.", lists the
 *     item's ACTUAL numeric properties in canonical snake_case, and
 *     accepting one commits a working equation.
 * Fails loudly (nonzero exit) on any assertion failure or unexpected page
 * console error. Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/equation_discoverability_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

// Known INTERLEAVED-FLEET boot noise (documented in concerns.md, shared with
// colorfield_probe.js) — NOT from the equation-discoverability path.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// EXPECTED mid-typing evaluation noise (NOT a bug): the autocomplete check
// exercises page.keyboard.type() char-by-char to test live re-ranking, and
// every intermediate fragment ("self.t", "self.ti", …) is a syntactically
// valid-looking reference to a property that doesn't exist YET — exactly the
// case evaluateState's OWN "has no property" console.error (core/report.js
// reportOnce) is designed to report (the .eq-badge-error affordance exists
// precisely to surface this to the user WHILE typing). This is the SAME
// class of error the "camelCase is rejected" check deliberately provokes
// too. Ignored ONLY here, narrowly, by message shape — anything else still
// fails the probe.
const isExpectedMidTypeNoise = (s) => /PowerRP expression error at items\..*(has no property|is not a numeric property)/.test(s);

const expectedNoise = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // Expected mid-typing evaluation noise routes to its OWN bucket (still
    // visible in the final report) instead of failing the probe — see
    // isExpectedMidTypeNoise's comment. Anything else is a real failure.
    if (isExpectedMidTypeNoise(text)) expectedNoise.push(text);
    else errors.push(`console.error: ${text}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // KNOWN PUPPETEER/HEADLESS QUIRK (same family as colorfield_probe.js's
  // documented setPointerCapture issue): DraggableNumber's onPointerDown
  // best-effort try/catches setPointerCapture (a synthetic PointerEvent has
  // no trusted user activation, so it silently no-ops in headless), but
  // onPointerUp's releasePointerCapture has NO matching guard — it throws
  // NotFoundError uncaught, aborting the click-without-drag → openTextEntry
  // path before it runs. This is a pre-existing src/lib/DraggableNumber.svelte
  // gap (outside this task's fence — a shared library component untouched by
  // this diff), not a defect in the equation-discoverability code under test.
  // Worked around HERE, probe-side, exactly like colorfield_probe.js works
  // around its own pointer-capture quirk: guard release with hasPointerCapture.
  await page.evaluateOnNewDocument(() => {
    const orig = Element.prototype.releasePointerCapture;
    Element.prototype.releasePointerCapture = function (id) {
      if (this.hasPointerCapture?.(id)) orig.call(this, id);
    };
  });
  // navigator.clipboard.writeText MOCK: this sandboxed headless Chrome denies
  // Browser.grantPermissions for the Clipboard API outright ("Permission
  // can't be granted in current context" — verified: fails identically via
  // browserContext.overridePermissions, a fresh incognito context, AND a
  // direct CDP Browser.grantPermissions call; an environment limitation, not
  // fixable from the page/test side). Intercepting the call itself instead
  // still exercises copyPath's REAL code path (Inspector.svelte's onclick →
  // canonicalPropPath → navigator.clipboard.writeText) end-to-end; only the
  // OS clipboard round-trip is swapped for a capture array. The app's own
  // failure handling (loud console.error, never silent) is tested for real
  // where the environment allows it (colorfield/other probes don't need
  // clipboard; this is the first PowerRP probe to hit this limitation).
  await page.evaluateOnNewDocument(() => {
    window.__copiedTexts = [];
    navigator.clipboard.writeText = (text) => {
      window.__copiedTexts.push(text);
      return Promise.resolve();
    };
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  if (errors.length) console.warn("(ignoring interleaved-fleet boot noise:\n  " + errors.join("\n  ") + "\n)");
  errors.length = 0; // reset: from here, ANY console error is a probe failure

  // ── Add a Fancy Arrow (the user's exact complaint case) and select it ──────
  const arrowId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.runCommand("add-fancy-arrow");
    return app.selection;
  });
  ok(arrowId, "fancy arrow created + selected");
  await new Promise((r) => setTimeout(r, 200));

  const findRow = (label) => `[...document.querySelectorAll(".inspector .row")].find(r => r.querySelector(".label")?.textContent === ${JSON.stringify(label)})`;

  // The Property Panel is a SCROLLING region (.panel-body {overflow:auto});
  // a Fancy Arrow's rows (Positioning + Formatting + Arrow categories) exceed
  // its visible height, so getBoundingClientRect() on a lower row (e.g. "End
  // width") reports a position OUTSIDE the panel's clipped viewport — real
  // screen-coordinate interactions (page.mouse.move, elementFromPoint-style
  // hover) land on whatever IS visible there instead. scrollIntoView before
  // any hover/click-by-coordinate step. (DOM-dispatched events on an element
  // HANDLE, e.g. openTextEntryOnRow below, don't need this — only real
  // screen-position interactions do.)
  async function scrollRowIntoView(label) {
    await page.evaluate((expr) => eval(expr)?.scrollIntoView({ block: "center" }), findRow(label));
    await new Promise((r) => setTimeout(r, 80));
  }

  // Click-without-drag on a row's DraggableNumber scrubber (its .dn root) —
  // opens equation text entry (NumericField's onedit delegation). A zero-
  // movement synthetic PointerEvent down+up stays under DraggableNumber's
  // CLICK_SLOP_PX, so it registers as a click, not a drag.
  let nextPointerId = 100;
  async function openTextEntryOnRow(label) {
    const opened = await page.evaluate((expr, pid) => {
      const row = eval(expr);
      const dn = row?.querySelector(".numfield .dn");
      if (!dn) return false;
      const r = dn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      dn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: pid, button: 0, clientX: cx, clientY: cy }));
      dn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: pid, button: 0, clientX: cx, clientY: cy }));
      return true;
    }, findRow(label), nextPointerId++);
    await new Promise((r) => setTimeout(r, 150));
    return opened;
  }

  // Sets an .eq-input's value in ONE shot (native setter + one "input" event)
  // rather than page.keyboard.type()'s char-by-char keystrokes. WHY: typing
  // "self.startWidth" letter by letter transiently passes through "self.s",
  // "self.st", … — each a SYNTACTICALLY valid-looking (but nonexistent)
  // property reference that legitimately reaches evaluateState's OWN
  // "has no property" console.error (core/report.js reportOnce; this is
  // documented, intentional live-typing feedback, not a bug — the .eq-badge
  // -error affordance exists precisely to show it). That transient churn is
  // real UX, just not what THIS probe is checking; setting the final value in
  // one dispatch exercises the identical onEqInput handler without it.
  async function setEqValue(selectorExpr, text) {
    await page.evaluate((expr, v) => {
      const el = eval(expr);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, selectorExpr, text);
    await new Promise((r) => setTimeout(r, 100));
  }

  // ── PART 2: PATH TOOLTIP — hovering the "End width" row's label ────────────
  await scrollRowIntoView("End width");
  const endWidthRowBox = await page.evaluate((expr) => {
    const row = eval(expr);
    const label = row?.querySelector(".label");
    if (!label) return null;
    const r = label.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, findRow("End width"));
  ok(endWidthRowBox, "End Width row + label found");

  await page.mouse.move(endWidthRowBox.x, endWidthRowBox.y);
  await new Promise((r) => setTimeout(r, 50));
  await page.mouse.move(endWidthRowBox.x + 1, endWidthRowBox.y); // pointermove: Tooltip anchors on real movement
  await new Promise((r) => setTimeout(r, 150));
  const tooltipText = await page.evaluate(() =>
    [...document.querySelectorAll(".tt-tip")].map((t) => t.textContent.trim()).join(" | "));
  ok(tooltipText.includes("self.end_width"), `hover tooltip shows the canonical self path; got ${JSON.stringify(tooltipText)}`);
  ok(tooltipText.includes("fancy_arrow") && tooltipText.includes("end_width"),
    `hover tooltip shows the absolute slug path too; got ${JSON.stringify(tooltipText)}`);
  ok(tooltipText !== "End width", "tooltip is NOT the banned label-echo");
  await page.mouse.move(20, 20); // move away, close the tooltip before the next check
  await new Promise((r) => setTimeout(r, 50));

  // ── PART 3: COPY PATH — clicking the row's copy icon ────────────────────────
  // Reads back window.__copiedTexts (the navigator.clipboard.writeText mock
  // installed at boot — see its comment for WHY the real OS clipboard isn't
  // reachable in this sandboxed headless environment).
  const copyClicked = await page.evaluate((expr) => {
    const row = eval(expr);
    const btn = row?.querySelector(".copy-path-btn");
    if (!btn) return false;
    btn.click();
    return true;
  }, findRow("End width"));
  ok(copyClicked, "copy-path icon found + clicked");
  await new Promise((r) => setTimeout(r, 150));
  const clipboardText = await page.evaluate(() => window.__copiedTexts.at(-1));
  ok(/^fancy_arrow(_\w+)?\.end_width$/.test(clipboardText),
    `copy-path writes the absolute canonical path; got ${JSON.stringify(clipboardText)}`);

  // ── PART 1: SNAKE_CASE ENTRY resolves against the camelCase-keyed property ──
  // Open text entry on End Width (click the DraggableNumber's click-without-
  // drag onedit hook) and type a snake_case equation referencing start_width
  // (stored key: startWidth) — the user's exact fancy-arrow complaint case.
  ok(await openTextEntryOnRow("End width"), "click-without-drag opened text entry on End Width");

  const eqInputSelector = () => `(${findRow("End width")})?.querySelector(".eq-input")`;
  const hasEqInput = await page.evaluate((expr) => !!eval(expr), eqInputSelector());
  ok(hasEqInput, "End Width field is in equation text-entry mode");

  // Type "self.start_width + 2" — canonical snake_case, must resolve against
  // the item's REAL stored key startWidth (default 3) -> commits to 5.
  await page.evaluate((expr) => eval(expr).focus(), eqInputSelector());
  await setEqValue(eqInputSelector(), "self.start_width + 2");
  const midEval = await page.evaluate((expr) => eval(expr).textContent, `(${findRow("End width")})?.querySelector(".eq-badge")`);
  ok(midEval && midEval.includes("5"), `live preview evaluates self.start_width + 2 = 5 (default startWidth 3 + 2); got ${JSON.stringify(midEval)}`);
  // No suggestion list is showing here (the caret sits after "2", not inside
  // an identifier) — Enter commits directly, nothing to dismiss first.
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 150));

  const storedEndWidth = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].endWidth, arrowId);
  ok(storedEndWidth === "self.startWidth + 2", `commit stores the CANONICAL camelCase form; got ${JSON.stringify(storedEndWidth)}`);
  const evaluatedEndWidth = await page.evaluate((id) => window.__powerrp_app.state().items[id].endWidth, arrowId);
  ok(evaluatedEndWidth === 5, `evaluated end width = 5; got ${evaluatedEndWidth}`);

  // ── PART 4: AUTOCOMPLETE lists real properties and commits a working equation ──
  // Re-open text entry on Start Width, type "self." and check the dropdown.
  ok(await openTextEntryOnRow("Start width"), "click-without-drag opened text entry on Start Width");
  const startWidthEqInput = () => `(${findRow("Start width")})?.querySelector(".eq-input")`;
  await page.evaluate((expr) => { eval(expr).value = ""; eval(expr).focus(); }, startWidthEqInput());
  await page.keyboard.type("self.", { delay: 20 });
  await new Promise((r) => setTimeout(r, 150));

  const suggestItems = await page.evaluate(() => [...document.querySelectorAll(".eqs-item .eqs-text")].map((e) => e.textContent));
  ok(suggestItems.includes("tip_length") && suggestItems.includes("end_width") && suggestItems.includes("start_width"),
    `autocomplete lists the item's ACTUAL numeric properties (canonical snake_case); got ${JSON.stringify(suggestItems)}`);
  ok(!suggestItems.some((t) => /[A-Z]/.test(t)), `every suggestion is canonical snake_case (no uppercase); got ${JSON.stringify(suggestItems)}`);

  // Narrow to "tip_w" and accept "tip_width" via keyboard (Down, Down, Enter
  // — or just type further and press Enter on the top match).
  await page.keyboard.type("tip_w", { delay: 20 });
  await new Promise((r) => setTimeout(r, 150));
  const narrowed = await page.evaluate(() => [...document.querySelectorAll(".eqs-item .eqs-text")].map((e) => e.textContent));
  ok(narrowed[0] === "tip_width", `top-ranked suggestion for "tip_w" is tip_width; got ${JSON.stringify(narrowed)}`);
  await page.keyboard.press("Enter"); // accept — should NOT commit the field (still editing)
  await new Promise((r) => setTimeout(r, 100));
  const afterAccept = await page.evaluate((expr) => eval(expr).value, startWidthEqInput());
  ok(afterAccept === "self.tip_width", `accepting the suggestion replaces the fragment; got ${JSON.stringify(afterAccept)}`);
  await page.keyboard.press("Enter"); // now commit (dropdown already closed)
  await new Promise((r) => setTimeout(r, 150));
  const storedStartWidth = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].startWidth, arrowId);
  ok(storedStartWidth === "self.tipWidth", `autocomplete-accepted equation commits correctly (canonical->stored); got ${JSON.stringify(storedStartWidth)}`);
  const evaluatedStartWidth = await page.evaluate((id) => window.__powerrp_app.state().items[id].startWidth, arrowId);
  ok(evaluatedStartWidth === 30, `evaluated start width = tip_width default 30; got ${evaluatedStartWidth}`);

  // ── PART 1 (continued): camelCase typed is NOT silently accepted ───────────
  // End Width is ALREADY in equation display mode (its stored value is the
  // string "self.startWidth + 2" from PART 1) — no DraggableNumber to
  // click-without-drag anymore; its .eq-input is already on screen.
  const stillHasEqInput = await page.evaluate((expr) => !!eval(expr), eqInputSelector());
  ok(stillHasEqInput, "End Width is already showing its equation text field (from the earlier commit)");
  await page.evaluate((expr) => eval(expr).focus(), eqInputSelector());
  await setEqValue(eqInputSelector(), "self.startWidth"); // camelCase — must NOT resolve
  const badCaseInvalid = await page.evaluate((expr) => eval(expr).classList.contains("invalid"), eqInputSelector());
  ok(badCaseInvalid, "typed camelCase (self.startWidth) shows the INVALID affordance — not silently accepted");
  // First Escape dismisses the (possibly open) suggestion dropdown only; the
  // SECOND Escape then reverts the invalid draft WITHOUT committing
  // (onEqKeydown's Escape branch never calls commitText on that path) — no
  // console.error expected; the field returns to the last-good value.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 80));
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 100));
  const revertedValue = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].endWidth, arrowId);
  ok(revertedValue === "self.startWidth + 2", `Escape reverted WITHOUT committing the rejected camelCase draft; end_width still ${JSON.stringify(revertedValue)}`);

  // ── Report ─────────────────────────────────────────────────────────────────
  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Equation discoverability probe passed: ${checks.length}/${checks.length} checks, zero UNEXPECTED console errors ` +
    `(${expectedNoise.length} expected mid-typing evaluation errors, all matched the documented "has no property" shape).`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
