/**
 * NUMERICFIELD ONE-UNDO-UNIT PROBE (browser) — proves the equation-aware numeric
 * field commits a text edit EXACTLY ONCE.
 *
 * WHY THIS EXISTS. commitText() used to leave `draft` at the typed text, so the
 * blur that FOLLOWS an Enter re-entered onEqBlur, compared the draft against a
 * `current` that is `null` in number mode, saw a difference, and committed a SECOND
 * time. app.commitPreview() → keyframed() always returns a FRESH doc, so that
 * second commit is a real duplicate undo entry: the user presses undo once and the
 * value does not come back. The same stale draft made Escape in number mode blur
 * into commitText() and log a spurious "equation not committed" error.
 * The fix is web/AngleField.svelte's endTextEntry() precedent — re-sync the draft to
 * what the document now holds — so blur sees no change and does nothing.
 *
 * WHAT IT PROVES, through the REAL app (undo entries counted at undoLog.commit,
 * the one place an undoable transaction is pushed):
 *   (1) type + Enter + click away  → ONE undo entry, and ONE undo fully restores;
 *   (2) type + click away (no Enter) → ONE undo entry (the blur commit path);
 *   (3) Escape → ZERO undo entries, the value untouched, and NO console error;
 *   (4) tabbing through an untouched equation row → ZERO undo entries, while an
 *       explicitly-OPENED editor abandoned untouched settles exactly ONCE (the
 *       `textEntry` clause AngleField carries too) — never twice;
 *   (5) an EQUATION commit is one entry too (the branch where `current` was not
 *       null and the double-commit only showed up on normalized text).
 * Driven through the VARIABLES PANEL: NumericField serves both panels — one
 * component, both surfaces — and a variable row is the simplest surfacing of it
 * (the eq_highlight_ref_probe.js precedent).
 *
 * Spawns its OWN isolated Vite (HMR/watch OFF — siblings may be editing) + headless
 * Chromium. Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/numericfield_undo_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const VAR_NAME = "speed";
const BASELINE = 5;   // the variable's committed starting value
const TYPED_NUMBER = 42;
const TYPED_BLUR_NUMBER = 7;
const TYPED_EQUATION = "speed * 3"; // authored on a SECOND variable, so it has a ref

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
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
  await page.setViewport({ width: 1400, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|WebGPU|repair:/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3000);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Two variables (both NumericField rows): the NUMBER row under test, and an
  // EQUATION row that references it.
  await page.evaluate((name, baseline) => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.addVariable(name);
    app.addVariable("follower");
    app.setPreview([[["vars", name], baseline]]); app.commitPreview();
    app.setPreview([[["vars", "follower"], `${name} * 2`]]); app.commitPreview();
    // Count UNDO ENTRIES at the single place they are pushed.
    window.__entries = 0;
    const log = app.undoLog;
    const orig = log.commit.bind(log);
    log.commit = (snap) => { window.__entries++; return orig(snap); };
  }, VAR_NAME, BASELINE);
  await sleep(300);

  const rowJs = (name) => `[...document.querySelectorAll(".varspanel .row")].find(r => r.querySelector(".var-name")?.value === ${JSON.stringify(name)})`;

  /** Command (in-page). Opens the row's text entry through the ƒ affordance. */
  const openEntry = async (name) => {
    await page.evaluate((js) => eval(js).querySelector(".eq-open").click(), rowJs(name));
    await sleep(200);
  };
  /** Command (in-page). Types `text` into the row's open equation input. */
  const type = async (name, text) => {
    await page.evaluate((js, t) => {
      const el = eval(js).querySelector(".eq-input");
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, t);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, rowJs(name), String(text));
    await sleep(150);
  };
  const entries = () => page.evaluate(() => window.__entries);
  const reset = () => page.evaluate(() => { window.__entries = 0; });
  const varValue = (name) => page.evaluate((n) => window.__powerrp_app.state().vars[n], name);
  const varStored = (name) => page.evaluate((n) => window.__powerrp_app.rawState().vars[n], name);

  // ── (1) type + Enter + click away = ONE entry, and ONE undo restores ────────
  await reset();
  await openEntry(VAR_NAME);
  await type(VAR_NAME, TYPED_NUMBER);
  await page.keyboard.press("Enter");
  await sleep(250);
  const afterEnter = await entries();
  // Then CLICK AWAY, exactly as the report describes (the blur that follows).
  await page.mouse.click(700, 450);
  await sleep(250);
  const afterClickAway = await entries();
  assert(afterEnter === 1, `Enter commits exactly ONE undo entry (got ${afterEnter})`);
  assert(afterClickAway === 1, `the click-away after Enter adds NOTHING (total ${afterClickAway})`);
  assert((await varValue(VAR_NAME)) === TYPED_NUMBER, `the typed value committed (${await varValue(VAR_NAME)})`);

  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(250);
  assert((await varValue(VAR_NAME)) === BASELINE, `ONE undo fully restores the prior value (got ${await varValue(VAR_NAME)}, want ${BASELINE})`);

  // ── (2) type + click away, no Enter = ONE entry ─────────────────────────────
  await reset();
  await openEntry(VAR_NAME);
  await type(VAR_NAME, TYPED_BLUR_NUMBER);
  await page.evaluate((js) => eval(js).querySelector(".eq-input").blur(), rowJs(VAR_NAME));
  await sleep(250);
  const afterBlur = await entries();
  assert(afterBlur === 1, `a blur-only commit is ONE undo entry (got ${afterBlur})`);
  assert((await varValue(VAR_NAME)) === TYPED_BLUR_NUMBER, `the blur commit stored the value (${await varValue(VAR_NAME)})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(200);
  assert((await varValue(VAR_NAME)) === BASELINE, `ONE undo restores after a blur commit (got ${await varValue(VAR_NAME)})`);

  // ── (3) Escape = ZERO entries, value untouched, no console error ────────────
  await reset();
  errors.length = 0;
  await openEntry(VAR_NAME);
  await type(VAR_NAME, 999);
  await page.keyboard.press("Escape");
  await sleep(250);
  await page.mouse.click(700, 450); // and the blur that follows must not commit either
  await sleep(250);
  assert((await entries()) === 0, `Escape writes NO undo entry (got ${await entries()})`);
  assert((await varValue(VAR_NAME)) === BASELINE, `Escape leaves the value untouched (${await varValue(VAR_NAME)})`);
  assert(errors.length === 0, `Escape logs no error (got ${JSON.stringify(errors)})`);

  // ── (4a) tabbing through an EQUATION row = ZERO entries ─────────────────────
  // The row renders as text because it HOLDS an equation (textEntry stays false),
  // so the blur decision is purely `draft !== currentText()` — the comparison this
  // fix changed. Focus, touch nothing, blur: no undo entry.
  await reset();
  await page.evaluate((js) => eval(js).querySelector(".eq-input").focus(), rowJs("follower"));
  await sleep(150);
  await page.evaluate((js) => eval(js).querySelector(".eq-input").blur(), rowJs("follower"));
  await sleep(250);
  assert((await entries()) === 0, `tabbing through an untouched equation row writes nothing (got ${await entries()})`);

  // ── (4b) the ƒ editor opened and abandoned = ONE entry, by design ───────────
  // `textEntry` alone makes a blur commit (web/AngleField.svelte carries the same
  // clause): the row was EXPLICITLY opened to enter a value, so leaving it settles
  // the field. The point of this check is that it settles ONCE, not twice.
  await reset();
  await openEntry(VAR_NAME);
  await page.evaluate((js) => eval(js).querySelector(".eq-input").blur(), rowJs(VAR_NAME));
  await sleep(250);
  assert((await entries()) === 1, `abandoning the opened editor settles ONCE (got ${await entries()})`);
  assert((await varValue(VAR_NAME)) === BASELINE, `abandoning it leaves the value unchanged (${await varValue(VAR_NAME)})`);

  // ── (5) an EQUATION commit is one entry too ─────────────────────────────────
  await reset();
  await type("follower", TYPED_EQUATION); // the row already renders as text (stored equation)
  await page.keyboard.press("Enter");
  await sleep(250);
  await page.mouse.click(700, 450);
  await sleep(250);
  const eqEntries = await entries();
  assert(eqEntries === 1, `an equation commit is exactly ONE undo entry (got ${eqEntries})`);
  assert((await varStored("follower")) === TYPED_EQUATION, `the equation stored verbatim (${JSON.stringify(await varStored("follower"))})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(200);
  assert((await varStored("follower")) === `${VAR_NAME} * 2`, `ONE undo restores the previous equation (${JSON.stringify(await varStored("follower"))})`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors present"); }
  console.log(fails.length ? `\nFAILED (${fails.length}): ${fails.join("; ")}` : `\nALL NUMERICFIELD UNDO ASSERTIONS PASSED`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(fails.length ? 1 : 0);
