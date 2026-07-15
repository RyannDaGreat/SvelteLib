/**
 * Equation field round-3 probe (Opus25): boots the PowerRP editor headless and
 * verifies the two new features end-to-end through the REAL app, driven mostly
 * through the VARIABLES PANEL (NumericField serves BOTH panels — one component,
 * both surfaces — and variable rows are structurally simpler / less churned than
 * plugin accordion rows):
 *   1. SYNTAX HIGHLIGHTING: a variable holding an equation string renders a
 *      colorized overlay (.eq-highlight) BEHIND a transparent-text input; token
 *      spans carry the correct .eq-tok-<cls> classes from the REAL tokenizer
 *      (var / op / num / self / error); the input text is transparent with a
 *      native caret; an UNKNOWN ref shows the error class (red).
 *   2. REFERENCE SCRUB WRITE-THROUGH: a variable whose stored value is a pure
 *      reference to ANOTHER variable renders as a SCRUBBER (not text) with the
 *      reference mark; scrubbing WRITES THROUGH to the referenced variable's
 *      value (one undo unit); slider stays affordanced as a reference; undo
 *      reverts once.
 *   3. Autocomplete/text path untouched (its own probe, equation_discoverability
 *      _probe.js, is the canonical gate; this probe additionally confirms the
 *      overlay coexists with typing).
 * Fails loudly (nonzero exit) on any assertion failure or unexpected page
 * console error. Run from the worktree root: node <this>.
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

const IGNORE_BOOT = [/PowerRP repair:/, /was missing/, /duration.*transition|transition.*duration/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));
// Live-typing evaluation feedback (mid-fragment unknown refs) is EXPECTED — the
// error affordance exists to surface it (same rationale as the SA5 probe).
const isExpectedEvalNoise = (s) => /PowerRP expression error at |has no property|Unknown reference|Unknown variable/.test(s);
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
  // Same headless pointer-capture guard the SA5/colorfield probes use (a
  // pre-existing src/lib/DraggableNumber.svelte gap, outside this task's fence).
  await page.evaluateOnNewDocument(() => {
    const orig = Element.prototype.releasePointerCapture;
    Element.prototype.releasePointerCapture = function (id) {
      if (this.hasPointerCapture?.(id)) orig.call(this, id);
    };
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const realBoot = errors.filter((e) => !isBootNoise(e));
  if (realBoot.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBoot.join("\n")); process.exit(1); }
  errors.length = 0; // from here any console error fails the probe

  // ── Seed variables via the real app API (one undo baseline afterwards) ──────
  // speed = 5 (the write-through target); follower = "speed" (a PURE reference
  // to speed — the reference special form); expr = "speed * 2 + ghost" (a general
  // equation exercising var/op/num/error highlight classes). All keyframed on
  // slide 0 through the same addVariable/commit path the panel uses.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.addVariable("speed");
    app.addVariable("follower");
    app.addVariable("expr");
    // Set values through setPreview/commitPreview (the field's own write path).
    app.setPreview([[["vars", "speed"], 5]]); app.commitPreview();
    app.setPreview([[["vars", "follower"], "speed"]]); app.commitPreview();
    app.setPreview([[["vars", "expr"], "speed * 2 + ghost"]]); app.commitPreview();
  });
  await new Promise((r) => setTimeout(r, 200));

  const varRow = (name) => `[...document.querySelectorAll(".varspanel .row")].find(r => r.querySelector(".var-name")?.value === ${JSON.stringify(name)})`;

  // ── FEATURE 1: SYNTAX HIGHLIGHTING (the "expr" variable's equation) ─────────
  await page.evaluate((expr) => eval(expr)?.scrollIntoView({ block: "center" }), varRow("expr"));
  await new Promise((r) => setTimeout(r, 80));

  const hl = await page.evaluate((expr) => {
    const row = eval(expr);
    const input = row?.querySelector(".eq-input");
    const overlay = row?.querySelector(".eq-highlight");
    if (!input || !overlay) return null;
    const toks = [...overlay.querySelectorAll("[class*='eq-tok-']")].map((s) => ({
      text: s.textContent,
      cls: [...s.classList].find((c) => c.startsWith("eq-tok-"))?.slice("eq-tok-".length),
      color: getComputedStyle(s).color,
    }));
    return {
      inputColor: getComputedStyle(input).color, // should be transparent
      caretColor: getComputedStyle(input).caretColor, // should NOT be transparent
      overlayText: overlay.textContent,
      toks,
    };
  }, varRow("expr"));
  ok(hl, "expr variable row has both an .eq-input and an .eq-highlight overlay");
  ok(hl && /rgba\(0, 0, 0, 0\)|transparent/.test(hl.inputColor), `input text is transparent (caret native); got ${hl?.inputColor}`);
  ok(hl && !/rgba\(0, 0, 0, 0\)|transparent/.test(hl.caretColor), `caret-color is NOT transparent (visible caret); got ${hl?.caretColor}`);
  ok(hl && hl.overlayText === "speed * 2 + ghost", `overlay renders the full display text; got ${JSON.stringify(hl?.overlayText)}`);
  const clsOf = (t) => hl.toks.find((k) => k.text === t)?.cls;
  ok(clsOf("speed") === "var", `"speed" highlighted as var; got ${clsOf("speed")}`);
  ok(clsOf("2") === "num", `"2" highlighted as num; got ${clsOf("2")}`);
  ok(hl.toks.some((k) => k.cls === "op"), `operators highlighted as op`);
  ok(clsOf("ghost") === "error", `unknown ref "ghost" highlighted as error; got ${clsOf("ghost")}`);
  // The error token color differs from a normal var token color (red vs blue).
  const varColor = hl.toks.find((k) => k.cls === "var")?.color;
  const errColor = hl.toks.find((k) => k.cls === "error")?.color;
  ok(varColor && errColor && varColor !== errColor, `error color (${errColor}) differs from var color (${varColor})`);

  // Typing coexists with the overlay: focus, type a char, overlay updates live.
  await page.evaluate((expr) => eval(expr).querySelector(".eq-input").focus(), varRow("expr"));
  await page.evaluate((expr) => {
    const el = eval(expr).querySelector(".eq-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "speed + 1");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, varRow("expr"));
  await new Promise((r) => setTimeout(r, 100));
  const liveOverlay = await page.evaluate((expr) => eval(expr).querySelector(".eq-highlight")?.textContent, varRow("expr"));
  ok(liveOverlay === "speed + 1", `overlay tracks live typing (before commit); got ${JSON.stringify(liveOverlay)}`);

  // FUNCTION AUTOCOMPLETE (Lead scope addition): typing a bare fragment that
  // matches an equation function name (equationFunctionNames() → closest_to_rim)
  // offers it as a "closest_to_rim(" candidate; accepting inserts with the open
  // paren AND the CALL NAME highlights as .eq-tok-call (distinct from a var).
  await page.evaluate((expr) => {
    const el = eval(expr).querySelector(".eq-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "clos"); el.focus(); el.setSelectionRange(4, 4);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, varRow("expr"));
  await new Promise((r) => setTimeout(r, 150));
  const fnSuggest = await page.evaluate(() => [...document.querySelectorAll(".eqs-item .eqs-text")].map((e) => e.textContent));
  ok(fnSuggest.includes("closest_to_rim("), `function autocomplete offers "closest_to_rim(" for "clos"; got ${JSON.stringify(fnSuggest)}`);
  await page.keyboard.press("Enter"); // accept the function candidate
  await new Promise((r) => setTimeout(r, 100));
  const afterFn = await page.evaluate((expr) => eval(expr).querySelector(".eq-input").value, varRow("expr"));
  ok(afterFn === "closest_to_rim(", `accepting inserts the function name with open paren; got ${JSON.stringify(afterFn)}`);
  const fnCallCls = await page.evaluate((expr) => {
    const overlay = eval(expr).querySelector(".eq-highlight");
    const tok = [...overlay.querySelectorAll("[class*='eq-tok-']")].find((s) => s.textContent === "closest_to_rim");
    return tok ? [...tok.classList].find((c) => c.startsWith("eq-tok-"))?.slice("eq-tok-".length) : null;
  }, varRow("expr"));
  ok(fnCallCls === "call", `function name highlights distinctly as .eq-tok-call; got ${fnCallCls}`);

  await page.keyboard.press("Escape"); // dismiss suggestions
  await page.keyboard.press("Escape"); // revert the draft, leave "expr" = "speed * 2 + ghost"
  await new Promise((r) => setTimeout(r, 100));

  // ── FEATURE 2: REFERENCE SCRUB WRITE-THROUGH ("follower" → "speed") ─────────
  await page.evaluate((expr) => eval(expr)?.scrollIntoView({ block: "center" }), varRow("follower"));
  await new Promise((r) => setTimeout(r, 80));

  const refShape = await page.evaluate((expr) => {
    const row = eval(expr);
    return {
      hasScrubber: !!row?.querySelector(".numfield .dn"),
      hasInput: !!row?.querySelector(".eq-input"),
      hasMark: !!row?.querySelector(".eq-ref-mark"),
      shownValue: row?.querySelector(".dn-value")?.textContent,
    };
  }, varRow("follower"));
  ok(refShape.hasScrubber, "pure-variable-reference row renders a SCRUBBER (DraggableNumber), not text");
  ok(!refShape.hasInput, "reference row is NOT a text input");
  ok(refShape.hasMark, "reference row shows the reference mark (.eq-ref-mark)");
  ok(refShape.shownValue === "5", `scrubber shows the referenced variable's value (speed=5); got ${JSON.stringify(refShape.shownValue)}`);

  // Scrub the follower row: drag its .dn scrubber up. The write-through must
  // change the VARIABLE "speed" (not "follower", which keeps its "speed" ref).
  const dnBox = await page.evaluate((expr) => {
    const dn = eval(expr).querySelector(".numfield .dn");
    const r = dn.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, varRow("follower"));
  const undoDepthBefore = await page.evaluate(() => window.__powerrp_app.undoLog?.past?.length ?? window.__powerrp_app.undoLog?.log?.length ?? null);
  await page.mouse.move(dnBox.cx, dnBox.cy);
  await page.mouse.down();
  await page.mouse.move(dnBox.cx, dnBox.cy - 30, { steps: 10 }); // drag UP = increase (unbounded var row: 1/px)
  await new Promise((r) => setTimeout(r, 60));
  // Mid-drag (preview): speed should already be rising, follower still "speed".
  const midScrub = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { speed: app.state().vars.speed, followerStored: app.rawState().vars.follower };
  });
  ok(midScrub.speed > 5, `mid-scrub: referenced variable speed rose live (preview); got ${midScrub.speed}`);
  ok(midScrub.followerStored === "speed", `mid-scrub: follower row STILL stores its reference "speed" (not demoted); got ${JSON.stringify(midScrub.followerStored)}`);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 120));

  const afterScrub = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return {
      speedStored: app.rawState().vars.speed,
      followerStored: app.rawState().vars.follower,
      followerEvaluated: app.state().vars.follower,
    };
  });
  ok(typeof afterScrub.speedStored === "number" && afterScrub.speedStored > 5,
    `commit: speed VARIABLE was written through (now ${afterScrub.speedStored})`);
  ok(afterScrub.followerStored === "speed", `commit: follower row unchanged — still the reference "speed"; got ${JSON.stringify(afterScrub.followerStored)}`);
  ok(afterScrub.followerEvaluated === afterScrub.speedStored, `follower still evaluates to speed's value (${afterScrub.followerEvaluated})`);

  // Undo reverts the write-through in ONE step (speed back to 5).
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 120));
  const afterUndo = await page.evaluate(() => window.__powerrp_app.rawState().vars.speed);
  ok(afterUndo === 5, `undo reverts the scrub in ONE unit (speed back to 5); got ${afterUndo}`);

  // ── Report ──────────────────────────────────────────────────────────────────
  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Equation highlight + reference-scrub probe passed: ${checks.length}/${checks.length} checks, zero UNEXPECTED console errors ` +
    `(${expectedNoise.length} expected mid-typing evaluation errors).`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
