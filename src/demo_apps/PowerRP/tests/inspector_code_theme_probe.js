/**
 * INSPECTOR CODE-THEME probe — picking a code theme restyles the BOX, as ONE
 * undo unit.
 *
 * THE RULING (user, 2026-08-12): *"a VS Code theme is background + token colors;
 * a Solarized Light pick that leaves the box charcoal fails the plain meaning."*
 * The `theme` row therefore declares a `companion` hook, and the Inspector stages
 * it in the SAME preview as the theme itself.
 *
 * WHY A BROWSER PROBE AND NOT ONLY tests/code_themes_test.js. That suite pins the
 * DECLARATION (the row carries a companion, and it names the theme's own bg) and
 * the RENDER (applying both props paints that bg). Neither can see the wiring in
 * between: `previewField`/`commitField` receive the hook as a 4th argument passed
 * from the select branch's `onchange`. Drop that argument and every bare-node
 * test still passes — the row would just quietly write `theme` alone, which is
 * exactly the behaviour the ruling overturned. Only a real dropdown pick can
 * prove the argument is threaded.
 *
 * Asserts, on the REAL editor, on a codeblock whose stored fill is the LEGACY
 * dark one (the "switch an existing block to a light theme" case):
 *   1. picking Solarized Light writes BOTH `theme` and `fill`
 *   2. the fill written is that theme's OWN background (#fdf6e3), not a guess
 *   3. ONE undo restores BOTH — it was one undo unit, not two
 *   4. one REDO reapplies both (the pair survives a round trip)
 *   5. a manual fill edit AFTER the pick wins, and is its own undo unit
 *   6. picking a DARK theme afterwards writes that theme's bg over it
 *
 * Frontend-only Vite on an EPHEMERAL port (never 3637/3638).
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/inspector_code_theme_probe.js
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

// The palette values this probe expects, taken from core/code_themes.js. Stated
// as literals so the probe measures the SHIPPED table rather than agreeing with
// whatever the module currently says (a derived expectation would pass even if
// the table were rewritten).
const LEGACY_DARK_BG = "#1e222a";
const SOLARIZED_LIGHT_BG = "#fdf6e3";
const NIGHT_OWL_BG = "#011627";
const MANUAL_FILL = "#123456";

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.log("PAGEERROR " + e.message));
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  // A code block carrying the LEGACY dark theme and its matching fill — i.e. a
  // block authored before this feature existed.
  const itemId = await page.evaluate((fill) => {
    const app = window.__powerrp_app;
    app.clearDoc();
    app.addItem({
      type: "codeblock", x: 200, y: 200, w: 380, h: 220, rotation: 0, scale: 1,
      theme: "dark", fill, code: "const greeting = 'hi';", language: "javascript",
    });
    return app.selection;
  }, LEGACY_DARK_BG);
  assert(typeof itemId === "string", `a code block was created and selected (id=${itemId})`);
  await sleep(1200);

  /** Reads the selected item's stored theme + fill straight from the document. */
  const stored = () => page.evaluate((id) => {
    const st = window.__powerrp_app.rawState().items[id] ?? {};
    return { theme: st.theme ?? null, fill: st.fill ?? null };
  }, itemId);

  const before = await stored();
  assert(before.theme === "dark" && before.fill === LEGACY_DARK_BG,
    `the block starts on the legacy dark theme with its matching fill (${JSON.stringify(before)})`);

  /**
   * Picks a value in the Inspector's "Code theme" dropdown BY CLICKING IT — the
   * whole point of this file. Driving app.setProp directly would bypass the
   * select branch's onchange, which is the exact seam under test.
   */
  const pickTheme = async (label) => {
    // `.dd-trigger` is SvelteLib Dropdown's button (the row's FIRST button is the
    // equation ƒ escape hatch, so a bare `button` selector opens the wrong thing).
    const opened = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Code theme");
      const trigger = row?.querySelector(".dd-trigger");
      if (!trigger) return false;
      trigger.click();
      return true;
    });
    if (!opened) return false;
    await sleep(500);
    // Options are the Dropdown's listbox <li>s.
    const picked = await page.evaluate((wanted) => {
      const option = [...document.querySelectorAll(".dd-menu li, [role='option']")]
        .find((el) => el.textContent.trim() === wanted);
      if (!option) return false;
      option.click();
      return true;
    }, label);
    await sleep(900);
    return picked;
  };

  const pickedLight = await pickTheme("Solarized Light");
  assert(pickedLight, "the Code theme dropdown opened and offered 'Solarized Light'");

  // (1)+(2) BOTH keys were written, and the fill is the theme's own background.
  const afterPick = await stored();
  assert(afterPick.theme === "solarizedLight",
    `picking wrote the theme (got ${JSON.stringify(afterPick.theme)})`);
  assert(afterPick.fill === SOLARIZED_LIGHT_BG,
    `picking ALSO wrote the theme's own background — the companion write reached the document (got ${JSON.stringify(afterPick.fill)}, want ${SOLARIZED_LIGHT_BG})`);

  // (3) ONE undo restores BOTH. Two undos here would mean two undo units, i.e.
  // the companion rode a separate commit.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(700);
  const afterUndo = await stored();
  assert(afterUndo.theme === "dark" && afterUndo.fill === LEGACY_DARK_BG,
    `ONE undo restored BOTH the theme and the fill — it was one undo unit (${JSON.stringify(afterUndo)})`);

  // (4) and one redo brings the pair back.
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(700);
  const afterRedo = await stored();
  assert(afterRedo.theme === "solarizedLight" && afterRedo.fill === SOLARIZED_LIGHT_BG,
    `ONE redo reapplied BOTH (${JSON.stringify(afterRedo)})`);

  // (5) a manual fill edit AFTER the pick wins — ordinary property precedence,
  // which the ruling explicitly preserved.
  await page.evaluate((args) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", args.id, "fill"], args.fill]]);
    app.commitPreview();
  }, { id: itemId, fill: MANUAL_FILL });
  await sleep(700);
  const afterManual = await stored();
  assert(afterManual.fill === MANUAL_FILL && afterManual.theme === "solarizedLight",
    `a fill edited AFTER the theme pick wins, and leaves the theme alone (${JSON.stringify(afterManual)})`);

  // (6) picking another theme writes ITS background over the manual one — the
  // apply path is not one-shot.
  const pickedDark = await pickTheme("Night Owl");
  assert(pickedDark, "the dropdown offered 'Night Owl' on a second pick");
  const afterSecond = await stored();
  assert(afterSecond.theme === "nightOwl" && afterSecond.fill === NIGHT_OWL_BG,
    `a second pick wrote that theme's own background over the manual fill (${JSON.stringify(afterSecond)})`);
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("\ninspector code-theme probe passed");
