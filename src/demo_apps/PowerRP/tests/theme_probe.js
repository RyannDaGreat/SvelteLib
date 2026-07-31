/**
 * Theme probe (14.11 "MORE COLOR THEMES"): boots the editor once, then cycles
 * EVERY registered theme (app.svelte.js THEMES) checking for missing-token
 * regressions via getComputedStyle — background != text color, and every
 * --a-* / --fg* / --bg / --control-bg / --border token this file spot-checks
 * resolves to a non-empty string (a typo'd token name resolves to "" in
 * getComputedStyle, which is exactly the failure mode a silent CSS cascade
 * would produce). Also screenshots each theme with the inspector open on a
 * selected item, an equation-valued row visible (the arrow's from/to, chained
 * through --a-eq-*), and the hint bar — for VLM taste review.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/theme_probe.js <shot_dir>
 */
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
// THE SHOT DIR IS OPTIONAL, and that is a BUG FIX, not a convenience.
// This was `await mkdir(process.argv[2])` unconditionally — and run_all.mjs
// invokes every probe with NO arguments, so mkdir(undefined) threw at import
// time and this probe failed in 0s in EVERY gate run it has ever been part of.
// It passed when a human ran it by hand with a directory, which is exactly how
// a permanently-red gate entry goes unnoticed. The token checks below are the
// probe's actual job; the screenshots are a side product for taste review.
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

// Tokens every theme must resolve to a non-empty value (base :root declares
// all of these; a theme override block must never shadow one with an empty/
// unset custom property — see app.css's per-theme blocks).
const SPOT_CHECK_TOKENS = [
  "--bg", "--fg", "--fg-dim", "--accent", "--border", "--control-bg",
  "--a-panel-bg", "--a-canvas-bg", "--a-hover-bg", "--a-selection", "--a-guide",
  "--a-keyed", "--a-endpoint", "--a-anchor", "--a-modifier",
  "--a-scrollbar", "--a-scrollbar-hover",
  "--a-eq-var", "--a-eq-prop", "--a-eq-anchor", "--a-eq-self", "--a-eq-call",
  "--a-eq-member", "--a-eq-num", "--a-eq-punct", "--a-eq-error",
  "--a-code-plain", "--a-code-keyword", "--a-code-string", "--a-code-comment",
  "--a-split-handle", "--a-split-handle-hover", "--a-palette-shadow",
];

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // HMR OFF, for the same reason cli/render_job.js turns it off: this probe
  // takes 40 screenshots over ~40s, and ANY edit to app source during that
  // window reloads the page mid-capture. Observed failing exactly that way —
  // `Page.captureScreenshot timed out` while the log showed a stream of
  // "page reload ports.js / paint_skia.js" from a concurrent editor. Nothing
  // here depends on live-reload; the page is loaded once and driven by CDP.
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false }, // ephemeral port — never 3637/3638
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

// SwiftShader + --no-sandbox: this probe screenshots the WebGPU editor, so it
// needs the SAME software-GL launch flags as the other GPU probes
// (skia_browser_qa.js / caret_accuracy_qa.js) — a headless bare launch has no
// GPU and, as root, refuses to start without --no-sandbox.
// protocolTimeout raised past puppeteer's 30s default: this probe now captures
// 40 themes (one per family pole) on a SOFTWARE GL surface, where a single
// screenshot of the Skia canvas can take several seconds under load.
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"], protocolTimeout: 180000 });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // Headless SwiftShader has no WebGPU adapter, so videoV7 logs its own
    // fallback notice on EVERY boot and then falls back correctly. This probe
    // was failing on it at baseline — unrelated to themes, and a permanently
    // red probe is a gate nobody can read. Same whitelist convention as
    // render_gpu/tests/blend_browser_probe.js.
    if (m.type() === "error" && !/no WebGPU adapter|WebGPU init failed/i.test(m.text())) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  // Poll for the app mount hook rather than a fixed sleep — main.js awaits
  // font loading (loadFonts()) before mount(), so boot time is font-load-
  // dependent, not a fixed constant (editor_smoke.js's flat 600ms sleep is
  // the SAME race, just usually won under load; poll instead of copying it).
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: 10000 });

  // Select the arrow (equation-valued from/to — demo.powerrp.json id 510eda10)
  // so the Inspector shows an equation row chained through --a-eq-*.
  await page.evaluate(() => {
    window.__powerrp_app.selection = "510eda10";
  });
  await new Promise((r) => setTimeout(r, 200));

  // Read THEMES off the already-loaded app module. This app's OWN vite.config
  // sets `root: web/` (see vite.config.js), so the module is served at
  // "/app.svelte.js" — NOT under a "/src/demo_apps/..." prefix (that prefix
  // is the SvelteLib repo's root, which this dev server does not serve from).
  const themeIds = await page.evaluate(async () => {
    const mod = await import(new URL("/app.svelte.js", location.origin).href);
    return mod.THEMES.map((t) => t.id);
  });

  console.log(`Probing ${themeIds.length} themes: ${themeIds.join(", ")}`);

  for (const id of themeIds) {
    await page.evaluate((themeId) => window.__powerrp_app.setTheme(themeId), id);
    await new Promise((r) => setTimeout(r, 150));

    const result = await page.evaluate((tokens) => {
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue("--bg").trim();
      const fg = cs.getPropertyValue("--fg").trim();
      const missing = tokens.filter((t) => cs.getPropertyValue(t).trim() === "");
      return { bg, fg, missing };
    }, SPOT_CHECK_TOKENS);

    if (result.bg === result.fg) errors.push(`[${id}] --bg equals --fg ("${result.bg}") — invisible text`);
    if (result.missing.length) errors.push(`[${id}] missing/empty tokens: ${result.missing.join(", ")}`);

    // Screenshot: inspector open (selected arrow, equation row visible) + hint bar.
    // Only when a shot dir was asked for — see the note at `const shots`.
    if (shots) await page.screenshot({ path: `${shots}/theme_${id}.png` });
  }

  if (errors.length) {
    console.error("THEME PROBE FAILURES:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`Theme probe passed for all ${themeIds.length} themes.${shots ? ` Screenshots written to ${shots}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
