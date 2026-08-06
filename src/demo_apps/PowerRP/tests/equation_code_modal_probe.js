/**
 * THE `{}` EQUATION CODE MODAL — browser probe.
 *
 * User, 2026-08-06: "You know how some properties have {} displayed on them when
 * editing code? Equations should always have that option too - a code editing
 * modal, with correct autocomplete/highlighting pops up so u can edit the equation
 * multiline."
 *
 * What this pins, and why each half needs a real browser:
 *   - THE BUTTON EXISTS ON ALL THREE SURFACES that render an equation field —
 *     NumericField (X), AngleField (Rotation) and Inspector's generic
 *     `equationEntry` (Blend mode) — because "always" is the requirement and one
 *     button per surface is how it would silently become two-out-of-three. Asserted
 *     by the mdi:code-braces icon NAME in the row's `.code-open` slot, the
 *     evaluate_affordance_probe.js idiom: an icon absent from the set renders an
 *     EMPTY button with no build error (the 3e79a24 bug), so pixels would look fine
 *     either way while the attribute is the thing that was verified.
 *   - IT DOES NOT APPEAR ON A NON-EQUATION ROW. The mutual exclusion is structural
 *     (it lives inside the equation branch), so both halves are checked.
 *   - MONACO OPENS on the equation language, seeded with the row's DISPLAY text —
 *     and the language is read off the MODEL, not the prop, because an unregistered
 *     id falls back to plaintext silently (MONACO_LANGUAGES' note).
 *   - HIGHLIGHTING REACHES THE PIXELS as several DISTINCT colours. Not which colours:
 *     that is the theme's business. The count is the assertion because "one flat run"
 *     is the exact way this feature failed once already — a correct token stream
 *     against a theme with no rules for it, no error anywhere.
 *   - AUTOCOMPLETE OFFERS core/equationSuggest.js's CANDIDATES, checked on leaves that
 *     appear nowhere in the buffer so Monaco's word-based fallback cannot produce
 *     them. This check exists because the suggest widget was absent ENTIRELY:
 *     `editor.api` bundles no editor contributions, so no controller consulted any
 *     provider — true of Mermaid's completion too, since the modal landed.
 *   - MULTILINE COMMITS. The whole point: three lines of expression go in, and the
 *     document holds a working equation afterwards. Bare node already proves the
 *     grammar takes newlines (tests/expressions_test.js territory); what only a
 *     browser can prove is that the modal's Save reaches the field's commit.
 *   - THE UNITS RULE SURVIVES THE DETOUR — the reason the modal commits through the
 *     FIELD rather than writing a path itself. A ref-free `= 45` typed on ROTATION
 *     must land as 45 DEGREES (≈0.785 rad), not 45 radians. This is the check that
 *     would catch a future "simplification" that has commitCodeModal write the
 *     value directly.
 *
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/equation_code_modal_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

// HMR OFF: a concurrent edit anywhere in the import graph reloads the page and
// wipes window.__powerrp_app mid-probe (the render_job ruling, same reason).
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
const expectedNoise = [];

// Boot noise this container produces regardless of the code under test — repair
// reports, missing fonts, the legacy duration/transition migration, and no WebGPU
// adapter. The equation_discoverability_probe.js allowlist, verbatim.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The HIGHLIGHTING check deliberately stores an equation containing `nope`, because
  // the resolver's `error` class is the one token an author most needs coloured — so
  // the evaluator's OWN report about it is the expected result of that step, not a
  // probe failure. Routed to its own bucket (still printed) by message shape, the
  // evaluate_affordance_probe.js idiom. Anything else still fails the probe.
  const isExpectedEvalNoise = (t) => /PowerRP expression error at items\..*Unknown variable/.test(t);
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (isExpectedEvalNoise(text)) expectedNoise.push(text);
    else errors.push(`console.error: ${text}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(700);
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here any console error fails the probe

  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.addItem({ ...app.registry.get("rect").defaults, x: 100, y: 100, w: 200, h: 120 });
    return app.selection;
  });
  ok(rectId, "rect created + selected");

  const findRow = (label) => `[...document.querySelectorAll(".inspector .row")].find(r => r.querySelector(".label")?.textContent === ${JSON.stringify(label)})`;

  /** Query. The icon names in a row's `.code-open` accessory slot. */
  const codeIcons = (label) => page.evaluate((expr) => {
    const row = eval(expr);
    return row ? [...row.querySelectorAll(".code-open iconify-icon")].map((i) => i.getAttribute("icon")) : null;
  }, findRow(label));

  /** Command. Stores a raw value at an item key (dotted keys allowed). */
  async function store(key, value) {
    await page.evaluate((id, k, v) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, ...k.split(".")], v]]);
      app.commitPreview();
    }, rectId, key, value);
    await sleep(250);
  }

  // ── A LITERAL row has NO {} ────────────────────────────────────────────────
  ok((await codeIcons("X"))?.length === 0, `a LITERAL row shows no {} button; got ${JSON.stringify(await codeIcons("X"))}`);

  // ── All three equation surfaces DO ─────────────────────────────────────────
  await store("x", "= 10 + 5");                 // NumericField
  await store("rotation", "= 0.1");             // AngleField
  await store("blendMode", "= 'multiply'");     // Inspector's generic equationEntry
  for (const [label, surface] of [["X", "NumericField"], ["Rotation", "AngleField"], ["Blend mode", "Inspector equationEntry"]]) {
    const icons = await codeIcons(label);
    ok(icons?.includes("mdi:code-braces"), `${surface}: an equation row carries the {} button; got ${JSON.stringify(icons)}`);
  }

  // ── Clicking it opens MONACO on the equation language, seeded with the text ──
  await page.evaluate((expr) => eval(expr).querySelector(".code-open").click(), findRow("X"));
  await sleep(1200); // Monaco's first mount pulls its chunk
  const opened = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return {
      scope: app.codeModal?.scope,
      language: app.codeModal?.language,
      seed: app.codeModalValue(),
      hasMonaco: !!document.querySelector(".monaco-editor"),
      modelLanguage: window.__powerrp_app.codeModal?.language,
    };
  });
  ok(opened.scope === "equation", `the {} opens the EQUATION scope; got ${JSON.stringify(opened.scope)}`);
  ok(opened.language === "powerrp-equation", `on the equation language; got ${JSON.stringify(opened.language)}`);
  ok(/10\s*\+\s*5/.test(opened.seed), `seeded with the row's DISPLAY text; got ${JSON.stringify(opened.seed)}`);
  ok(opened.hasMonaco, "Monaco mounted (not a plain textarea)");

  // ── HIGHLIGHTING: the RESOLVER's classes reach the editor's pixels ──────────
  // Monaco renders each token run as <span class="mtkN">. ONE distinct class across
  // the whole buffer is the measured failure mode this feature already shipped once
  // (a DocumentSemanticTokensProvider with a correct token stream and a theme that
  // carried no semantic rules — every token in the default foreground, no error).
  // So the assertion is on the COUNT of distinct classes, not on which colours they
  // are: colours are the theme's business, "different kinds look different" is ours.
  await page.evaluate(() => window.__powerrp_app.closeCodeModal());
  await sleep(200);
  await store("x", "self.w * 2 +\n  abs(self.h) +\n  nope");
  await page.evaluate((expr) => eval(expr).querySelector(".code-open").click(), findRow("X"));
  await sleep(1600);
  const painted = await page.evaluate(() => ({
    modelLanguage: window.__powerrp_codeModal?.modelLanguage?.(),
    lines: document.querySelectorAll(".monaco-editor .view-line").length,
    // The bracket-pair decoration rides along on the class attribute; the token
    // colour is the FIRST class, so split it off before counting.
    distinct: [...new Set([...document.querySelectorAll(".monaco-editor span[class^=mtk]")].map((s) => s.className.split(" ")[0]))],
  }));
  ok(painted.modelLanguage === "powerrp-equation",
    `the MODEL's language is the equation one — read off the live editor, since an unregistered id falls back to plaintext silently; got ${JSON.stringify(painted.modelLanguage)}`);
  ok(painted.lines === 3, `a three-line equation renders as three lines; got ${painted.lines}`);
  ok(painted.distinct.length >= 4,
    `the resolver's token classes reach the pixels as DISTINCT colours (>= 4, not one flat run); got ${JSON.stringify(painted.distinct)}`);

  // ── AUTOCOMPLETE: Monaco's own widget, our candidates ───────────────────────
  // Ctrl+Space rather than relying on the trigger character: the assertion is that
  // the provider is consulted and its candidates render, and an explicit invoke tests
  // that without depending on synthetic-typing timing.
  //
  // THIS CHECK EXISTS BECAUSE THE WIDGET WAS ABSENT ENTIRELY. `editor.api` bundles no
  // editor CONTRIBUTIONS, so there was no suggest controller to consult any provider —
  // measured with a live provider returning five candidates and nothing on screen, and
  // it had been true of Mermaid's completion since the modal landed. monacoSetup.js now
  // imports suggestController.js, and this is what would notice if that import were
  // ever tidied away as unused.
  await page.evaluate(() => document.querySelector(".monaco-editor textarea")?.focus());
  await sleep(150);
  await page.keyboard.type("self.", { delay: 50 });
  await sleep(200);
  await page.keyboard.down("Control"); await page.keyboard.press("Space"); await page.keyboard.up("Control");
  await sleep(900);
  const suggested = await page.evaluate(() => ({
    visible: !!document.querySelector(".suggest-widget:not(.hidden)"),
    labels: [...document.querySelectorAll(".suggest-widget .monaco-list-row .label-name")].map((n) => n.textContent),
  }));
  ok(suggested.visible, "Ctrl+Space opens Monaco's suggest widget in the equation editor");
  // Asserted on labels that are actually RENDERED: the widget is virtualized and the
  // list is alphabetical, so a leaf like `w` sits below the fold and its absence would
  // say nothing. `cx`/`cy` are derived box-centre leaves and `bloom.radius` is an
  // effects-bundle one — none of them appears anywhere in the buffer, so they can only
  // have come from core/equationSuggest.js and not from Monaco's word-based fallback.
  for (const leaf of ["cx", "cy", "h", "bloom.radius"])
    ok(suggested.labels.includes(leaf),
      `the candidates are core/equationSuggest.js's, not word-based — offers "${leaf}", which is nowhere in the buffer; got ${JSON.stringify(suggested.labels.slice(0, 10))}`);
  await page.evaluate(() => window.__powerrp_app.closeCodeModal());
  await sleep(250);
  await store("x", "= 10 + 5");
  await page.evaluate((expr) => eval(expr).querySelector(".code-open").click(), findRow("X"));
  await sleep(600);

  // ── MULTILINE saves, through the field's own commit ─────────────────────────
  await page.evaluate(() => window.__powerrp_app.commitCodeModal("= 1 +\n  2 +\n  3"));
  await sleep(350);
  const afterMultiline = await page.evaluate((id) => ({
    stored: window.__powerrp_app.rawState().items[id].x,
    evaluated: window.__powerrp_app.state().items[id].x,
    modalClosed: window.__powerrp_app.codeModal === null,
  }), rectId);
  ok(afterMultiline.modalClosed, "Save closes the modal");
  ok(afterMultiline.evaluated === 6, `a THREE-LINE equation commits and evaluates (1+2+3); got ${JSON.stringify(afterMultiline)}`);

  // ── THE UNITS RULE: a ref-free `= 45` on ROTATION is 45 DEGREES ─────────────
  // This is why the modal commits through the FIELD. Committing the string here
  // would store 45 radians and look like a working save.
  await page.evaluate((expr) => eval(expr).querySelector(".code-open").click(), findRow("Rotation"));
  await sleep(500);
  ok(await page.evaluate(() => window.__powerrp_app.codeModal?.scope === "equation"), "the Rotation row's {} opens the same scope");
  await page.evaluate(() => window.__powerrp_app.commitCodeModal("= 45"));
  await sleep(350);
  const rot = await page.evaluate((id) => window.__powerrp_app.state().items[id].rotation, rectId);
  ok(Math.abs(rot - Math.PI / 4) < 1e-6,
    `a ref-free "= 45" on ROTATION lands as 45 DEGREES (${(Math.PI / 4).toFixed(6)} rad), not 45 radians; got ${rot}`);

  // ── A REF-FREE equation BAKES TO A NUMBER, so the {} correctly goes away ────
  // Measured while writing this probe, and worth pinning rather than working
  // around: after the three-line `1+2+3` save above, X stores the NUMBER 6 — the
  // field's own symmetric-commit rule ("what was typed decides the type"), which
  // the modal inherits precisely because it commits through the field. So the row
  // is a literal again and shows ƒ, not {}. A future change that made the modal
  // write the path directly would store the STRING and leave {} behind, and this
  // check is what would notice.
  ok((await codeIcons("X"))?.length === 0,
    `after a ref-free save the row is a LITERAL again and drops the {}; got ${JSON.stringify(await codeIcons("X"))}`);

  // ── Cancel retires the providers' resolver context ──────────────────────────
  // A REFERENCE equation, so the row stays an equation and keeps its {}.
  await store("x", "= self.w / 2");
  ok((await codeIcons("X"))?.includes("mdi:code-braces"), "a reference equation row carries the {}");
  await page.evaluate((expr) => eval(expr).querySelector(".code-open").click(), findRow("X"));
  await sleep(400);
  await page.evaluate(() => window.__powerrp_app.closeCodeModal());
  await sleep(200);
  ok(await page.evaluate(() => window.__powerrp_app.codeModal === null), "Cancel closes the modal without committing");

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Equation code modal probe passed: ${checks.length}/${checks.length} checks, zero UNEXPECTED console errors `
    + `(${expectedNoise.length} deliberately provoked "Unknown variable" reports from the highlighting step).`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
