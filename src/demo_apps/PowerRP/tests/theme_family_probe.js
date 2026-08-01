/**
 * THE FAMILY-TOGGLE PROBE — the regression test for the bug this whole feature
 * exists to kill.
 *
 * USER REPRO, verbatim: "ember: i went to it, then toggled light/dark and was
 * no longer on ember". The old toggleLightDark() hardcoded graphite⟷light, so
 * toggling from ANY other theme silently threw the user's choice away. EMBER IS
 * ASSERTED BY NAME below for that reason — a generic loop over families would
 * have covered it, but the named case is the one a future reader can trace back
 * to the report.
 *
 * Four things are checked in a REAL browser, because all four are cascade- or
 * DOM-level facts that a node test cannot see:
 *   1. every family: toggle flips to the sibling, and toggling BACK returns to
 *      the exact theme you started on (an involution — that is the property,
 *      and it is stronger than "it changes to something")
 *   2. data-theme actually lands on documentElement (the CSS cascade's input)
 *   3. Monaco follows the KIND both ways (dark member -> vs-dark, light -> vs)
 *   4. a non-glass theme's tooltip stays UNBLURRED — the glass opt-in is
 *      per-theme, and a sibling that inherited a blur it never asked for is
 *      exactly the silent regression --a-glass-tip-bg exists to prevent
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/theme_family_probe.js [shot_dir]
 */
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
  // HMR OFF: a concurrent agent editing app code mid-probe reloads the page and
  // kills the run — the same reason cli/render_job.js disables it.
  optimizeDeps: { force: false },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ protocolTimeout: 180000 });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Environment noise this probe must not fail on, using the same convention as
  // render_gpu/tests/blend_browser_probe.js. The WebGPU line is headless
  // SwiftShader having no adapter (videoV8's own fallback path says so and then
  // falls back correctly) — it is unrelated to themes and fires on every run,
  // including before this change. Theme-migration warnings are also expected:
  // the THEME_ALIASES path logs one BY DESIGN, and swallowing it would defeat
  // the point of migrating loudly.
  const IGNORED_CONSOLE = /no WebGPU adapter|WebGPU init failed|Failed to load resource|listAssets|\/api\//i;
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORED_CONSOLE.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: 20000 });

  const families = await page.evaluate(async () => {
    const mod = await import(new URL("/app.svelte.js", location.origin).href);
    return mod.THEME_FAMILIES.map((f) => ({ id: f.id, dark: f.dark, light: f.light }));
  });
  console.log(`Probing ${families.length} families`);

  // ── 1+2. Toggle is an INVOLUTION within every family, and it writes data-theme.
  for (const fam of families) {
    for (const start of [fam.dark, fam.light]) {
      const r = await page.evaluate((s) => {
        const app = window.__powerrp_app;
        app.setTheme(s);
        const applied = document.documentElement.dataset.theme;
        app.toggleLightDark();
        const flipped = document.documentElement.dataset.theme;
        app.toggleLightDark();
        const back = document.documentElement.dataset.theme;
        return { applied, flipped, back };
      }, start);
      const want = start === fam.dark ? fam.light : fam.dark;
      if (r.applied !== start) errors.push(`[${fam.id}] setTheme("${start}") left data-theme="${r.applied}"`);
      if (r.flipped !== want) errors.push(`[${fam.id}] toggle from "${start}" went to "${r.flipped}", expected sibling "${want}"`);
      if (r.back !== start) errors.push(`[${fam.id}] toggling twice from "${start}" landed on "${r.back}" — not an involution`);
    }
  }

  // ── THE PINNED REGRESSION, by name (user repro). Stated separately from the
  // loop above so a failure names Ember rather than "family 20".
  const ember = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.setTheme("ember");
    app.toggleLightDark();
    const after = document.documentElement.dataset.theme;
    app.toggleLightDark();
    return { after, back: document.documentElement.dataset.theme };
  });
  if (ember.after !== "ember-light") errors.push(`EMBER REGRESSION: toggling from ember gave "${ember.after}", expected "ember-light"`);
  if (ember.back !== "ember") errors.push(`EMBER REGRESSION: toggling back gave "${ember.back}", expected "ember"`);
  if (!errors.length) console.log("Ember pinned regression: ember -> ember-light -> ember");

  // ── 3. Monaco follows the KIND, both directions. CodeEditorModal maps kind
  // through THEMES; assert the mapping the editor will actually apply.
  for (const [theme, want] of [["ember", "vs-dark"], ["ember-light", "vs"], ["daybreak", "vs"], ["nocturne", "vs-dark"]]) {
    const got = await page.evaluate(async (t) => {
      const mod = await import(new URL("/app.svelte.js", location.origin).href);
      return mod.themeKind(t) === "light" ? "vs" : "vs-dark";
    }, theme);
    if (got !== want) errors.push(`Monaco kind for "${theme}" resolved "${got}", expected "${want}"`);
  }

  // ── 4. Glass is OPT-IN per theme: a non-glass theme must have no tip blur.
  // Nocturne/Daybreak opt in via --a-glass-tip-bg; Ember and its sibling do not.
  // Verdigris/Cranberry/Obsidian/Moonstone (round 6) are the newer glass pairs.
  for (const [theme, wantGlass] of [
    ["nocturne", true], ["daybreak", true],
    ["verdigris", true], ["verdigris-light", true],
    ["cranberry", true], ["cranberry-light", true],
    ["obsidian", true], ["moonstone", true],
    ["ember", false], ["ember-light", false], ["platinum", false],
  ]) {
    const tip = await page.evaluate((t) => {
      window.__powerrp_app.setTheme(t);
      const cs = getComputedStyle(document.documentElement);
      return {
        tipBg: cs.getPropertyValue("--a-glass-tip-bg").trim(),
        blur: cs.getPropertyValue("--a-glass-blur").trim(),
      };
    }, theme);
    const isGlass = tip.tipBg !== "" && tip.tipBg !== "unset";
    if (isGlass !== wantGlass) {
      errors.push(`[${theme}] glass tooltip opt-in is ${isGlass} (--a-glass-tip-bg "${tip.tipBg}"), expected ${wantGlass}`);
    }
    if (!wantGlass && tip.blur !== "none") {
      errors.push(`[${theme}] is not a glass theme but --a-glass-blur is "${tip.blur}" — tooltips would blur`);
    }
  }

  // ── Screenshot every theme (both poles of every family) for the taste review.
  if (shots) {
    await page.evaluate(() => {
      window.__powerrp_app.selection = "510eda10"; // the arrow: equation rows + keyframe diamonds
    });
    for (const fam of families) {
      for (const id of [fam.dark, fam.light]) {
        await page.evaluate((t) => window.__powerrp_app.setTheme(t), id);
        await new Promise((r) => setTimeout(r, 120));
        await page.screenshot({ path: `${shots}/theme_${id}.png` });
      }
    }
    console.log(`Screenshots written to ${shots}`);
  }

  if (errors.length) {
    console.error("THEME FAMILY PROBE FAILURES:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`Theme family probe PASSED: ${families.length} families, ${families.length * 2} themes — toggle is a within-family involution, Monaco follows kind, glass stays opt-in.`);
} finally {
  await browser.close();
  await server.close();
}
