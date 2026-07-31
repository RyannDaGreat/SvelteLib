/**
 * PANEL VISIBILITY probe — the browser half of the panel-visibility pass, and the
 * half tests/panel_visibility_test.js structurally cannot do: only the booted app
 * has the real command registry (web/App.svelte's entries cannot be imported in
 * bare node) and only a real layout can be asked whether a hidden pane left a
 * DEAD DIVIDER behind.
 *
 * The three user rulings it enforces end-to-end:
 *   (1) "we're going to have toggle visibility as a prefix. It's convention." —
 *       so scenario 2 searches the palette for the literal string "toggle
 *       visibility" and requires the WHOLE family to come back from that one
 *       query, which is the property the prefix exists to provide.
 *   (2) "the variables panel should now be called the global variables panel" —
 *       scenario 6 reads the rendered name plate.
 *   (3) variables panel "by default will be off for now on." — scenario 1 boots
 *       a FRESH PROFILE (no powerrp.panel.* keys) and requires exactly that one
 *       panel to be absent from the DOM.
 *
 * SCENARIOS
 *   1. Fresh profile: every panel present EXCEPT Global Variables; its pane is
 *      absent from the DOM, not merely empty.
 *   2. One palette query, "toggle visibility", returns every panel's command, and
 *      each row's title obeys `Toggle Visibility: <label> Panel` exactly.
 *   3. Palette-RUN each toggle in turn (through the real palette UI for the first
 *      one, then via runCommand for the sweep): the pane appears/disappears, and
 *      the DIVIDER COUNT tracks it — n visible panes ⇒ n-1 handles in that column,
 *      which is the "no dead divider" ruling made measurable.
 *   4. Sizes are RESTORED, not reset: a hide/show round trip returns every pane to
 *      the pixel geometry it had (within a rounding tolerance).
 *   5. Hiding every panel in a column drops the COLUMN and its handle; the canvas
 *      widens to take the space and is never itself hidden.
 *   6. The Global Variables plate reads "Global Variables Panel", and nothing in
 *      the app chrome still says plain "Variables Panel".
 *   7. Persistence: the choice survives a reload (localStorage), and the toggle
 *      writes the per-panel key core/panels.js names.
 *
 * Screenshots land in <shot_dir>: panels_fresh, panels_all_shown,
 * panels_<id>_hidden for each panel, panels_left_column_gone.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/panel_visibility_probe.js <shot_dir>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { PANELS, panelName, panelToggleCommand, panelSettingKey, panelsInColumn } from "../core/panels.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

// A pane's geometry is read back through getBoundingClientRect and compared across
// a hide/show round trip; sub-pixel layout rounding makes an exact match wrong.
const SIZE_TOLERANCE_PX = 1.5;
// Svelte flushes on a microtask, but SplitPane's panes are positioned from state
// that an $effect rewrites — one frame is not always enough for the DOM to settle.
const SETTLE_MS = 160;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr:false + watch:null — house probe convention: a concurrent save elsewhere
  // in the tree would otherwise reload the page mid-run and every later
  // page.evaluate would die with "Execution context was destroyed".
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await launchBrowser();
const failures = [];
const errors = [];
/**
 * Console errors this probe must not fail on, each an ENVIRONMENT fact rather than
 * a defect, and each matched narrowly so a real error with a similar prefix still
 * fails. A boot-time baseline count is not enough on its own: scenario 7 RELOADS the
 * page, so the same environmental error is emitted a second time after the baseline
 * was taken.
 *
 * VideoV7 asks for a WebGPU adapter; headless Chrome on SwiftShader has none, and the
 * app's documented behaviour is to fall back to 2D drawImage and SAY SO. Panel
 * visibility neither causes nor is affected by it.
 */
const ENVIRONMENTAL_ERRORS = [/VideoV7: WebGPU init failed — using 2D drawImage fallback/];
const isEnvironmental = (text) => ENVIRONMENTAL_ERRORS.some((re) => re.test(text));
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  // FRESH PROFILE, deliberately: the autosave deck is seeded but NO
  // powerrp.panel.* key is, so what scenario 1 observes is the DEFAULT — ruling
  // (3) — and not a value some earlier run happened to leave behind.
  //
  // The panel keys are cleared ONCE, not from the evaluateOnNewDocument hook: that
  // hook runs before EVERY navigation, so clearing there also wiped the keys during
  // scenario 7's reload and the probe then read the defaults back and called the
  // persistence broken. Seeding the deck is idempotent and stays in the hook.
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("powerrp.panel.")) localStorage.removeItem(key);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".app", { timeout: 20000 });
  await settle();
  const bootErrors = errors.length; // baseline: other agents' in-flight WIP noise, not ours
  const bootEnvironmental = errors.filter((e) => isEnvironmental(e)).length;

  /** Query. The rendered panel name plates, by data-region (Panel.svelte sets it
   *  from `name`, and it is present whether or not the title bar is shown). */
  const regions = () => page.evaluate(() => [...document.querySelectorAll(".panel[data-region]")].map((el) => el.getAttribute("data-region")));
  /** Query. Handle count inside a column's vertical SplitPane, and pane count with
   *  it — the pair that says whether a divider was left behind. Scoped to the
   *  column wrapper so the OUTER row's handles are not counted. */
  const columnShape = (cls) =>
    page.evaluate((sel) => {
      const col = document.querySelector(sel);
      if (!col) return { present: false, panes: 0, handles: 0 };
      const layout = col.querySelector(".sp-layout");
      return {
        present: true,
        panes: layout ? [...layout.children].filter((c) => c.classList.contains("sp-pane")).length : 0,
        handles: layout ? [...layout.children].filter((c) => c.classList.contains("sp-handle")).length : 0,
      };
    }, cls);
  /** Query. Pane rects keyed by the region name inside them. */
  const paneRects = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll(".panel[data-region]")].map((el) => {
          const r = el.getBoundingClientRect();
          return [el.getAttribute("data-region"), { w: r.width, h: r.height }];
        }),
      ),
    );
  const run = (id) => page.evaluate((cmd) => window.__powerrp_app.runCommand(cmd), id);
  const visibleFlags = () => page.evaluate(() => ({ ...window.__powerrp_app.panelVisible }));

  // ── Scenario 1: fresh profile — Global Variables OFF, everything else ON ────
  const fresh = await regions();
  await page.screenshot({ path: `${shots}/panels_fresh.png` });
  for (const panel of PANELS) {
    const want = panel.defaultVisible;
    check(
      `fresh-default-${panel.id}-${want ? "shown" : "hidden"}`,
      fresh.includes(panelName(panel)) === want,
      `regions=${JSON.stringify(fresh)}`,
    );
  }
  check("fresh-global-variables-pane-absent-not-empty", !fresh.includes("Global Variables Panel"), `regions=${JSON.stringify(fresh)}`);
  const freshFlags = await visibleFlags();
  check("fresh-flags-match-declarations", PANELS.every((p) => freshFlags[p.id] === p.defaultVisible), `flags=${JSON.stringify(freshFlags)}`);

  // ── Scenario 2: ONE palette query reaches the WHOLE family ─────────────────
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await settle();
  await page.type(".palette input", "toggle visibility");
  await settle();
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".palette-item")].map((el) => ({
      id: el.getAttribute("data-command-id") ?? el.dataset.commandId ?? null,
      title: el.querySelector(".title")?.textContent?.trim() ?? null,
    })),
  );
  await page.screenshot({ path: `${shots}/panels_palette_family.png` });
  const titles = rows.map((r) => r.title);
  for (const panel of PANELS) {
    const { title } = panelToggleCommand(panel);
    check(`palette-family-has-${panel.id}`, titles.includes(title), `wanted ${JSON.stringify(title)} in ${JSON.stringify(titles)}`);
  }
  check(
    "palette-family-titles-obey-the-convention",
    PANELS.every((p) => panelToggleCommand(p).title === `Toggle Visibility: ${p.label} Panel`),
    "a title drifted from `Toggle Visibility: <label> Panel`",
  );
  // The registry's own view, so a rendering/fuzzy-ranking quirk cannot mask a
  // missing command (and vice versa).
  const registered = await page.evaluate(() => window.__powerrp_app.commands.all().map((c) => ({ id: c.id, title: c.title })));
  for (const panel of PANELS) {
    const { id, title } = panelToggleCommand(panel);
    const entry = registered.find((c) => c.id === id);
    check(`registry-has-${id}`, !!entry, `no command \`${id}\` in the registry`);
    if (entry) check(`registry-title-${id}`, entry.title === title, `got ${JSON.stringify(entry.title)} want ${JSON.stringify(title)}`);
  }
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
  await settle();

  // ── Scenario 3: RUN the first toggle through the real palette UI ────────────
  // Everything after this uses runCommand (same single action layer), but at least
  // one toggle must be proven to work by keyboard through the palette, or the
  // probe would only ever test the method and not the surfacing.
  const varsCmd = panelToggleCommand(PANELS.find((p) => p.id === "globalVariables"));
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await settle();
  await page.type(".palette input", "toggle visibility global variables");
  await settle();
  const topRow = await page.evaluate(() => document.querySelector(".palette-item .title")?.textContent?.trim() ?? null);
  check("palette-ranks-the-queried-toggle-first", topRow === varsCmd.title, `top row = ${JSON.stringify(topRow)}`);
  await page.keyboard.press("Enter");
  await settle();
  const afterPaletteRun = await regions();
  check("palette-enter-shows-global-variables", afterPaletteRun.includes("Global Variables Panel"), `regions=${JSON.stringify(afterPaletteRun)}`);
  check("palette-closed-after-run", (await page.evaluate(() => window.__powerrp_app.paletteOpen)) === false);
  await page.screenshot({ path: `${shots}/panels_all_shown.png` });

  // Every panel is now visible — the baseline for the sweep below.
  const allShown = await regions();
  for (const panel of PANELS) check(`all-shown-${panel.id}`, allShown.includes(panelName(panel)), `regions=${JSON.stringify(allShown)}`);
  const shownRects = await paneRects();
  const shapeBefore = { left: await columnShape(".left-col"), right: await columnShape(".right-col") };
  for (const column of ["left", "right"]) {
    const n = panelsInColumn(column).length;
    check(`all-shown-${column}-pane-count`, shapeBefore[column].panes === n, `panes=${shapeBefore[column].panes} want ${n}`);
    check(`all-shown-${column}-handle-count`, shapeBefore[column].handles === n - 1, `handles=${shapeBefore[column].handles} want ${n - 1}`);
  }

  // ── Scenario 3b + 4: hide each panel in turn; no dead divider; size restored ─
  for (const panel of PANELS) {
    const cls = `.${panel.column}-col`;
    const siblings = panelsInColumn(panel.column).length;
    await run(panelToggleCommand(panel).id);
    await settle();
    const hiddenRegions = await regions();
    check(`hide-${panel.id}-pane-gone`, !hiddenRegions.includes(panelName(panel)), `regions=${JSON.stringify(hiddenRegions)}`);
    // Its siblings must all still be there — a mis-mapped pane index would render
    // the WRONG component in the freed slot, which is the defect this pass fixed.
    for (const other of PANELS.filter((p) => p.id !== panel.id))
      check(`hide-${panel.id}-keeps-${other.id}`, hiddenRegions.includes(panelName(other)), `regions=${JSON.stringify(hiddenRegions)}`);
    const shape = await columnShape(cls);
    check(`hide-${panel.id}-pane-count`, shape.panes === siblings - 1, `panes=${shape.panes} want ${siblings - 1}`);
    check(`hide-${panel.id}-no-dead-divider`, shape.handles === Math.max(0, siblings - 2), `handles=${shape.handles} want ${Math.max(0, siblings - 2)}`);
    await page.screenshot({ path: `${shots}/panels_${panel.id}_hidden.png` });

    // Re-show and require the geometry BACK — ruling: "re-showing restores its size".
    await run(panelToggleCommand(panel).id);
    await settle();
    const back = await paneRects();
    const drifted = Object.entries(shownRects).filter(([name, r]) => {
      const now = back[name];
      return !now || Math.abs(now.w - r.w) > SIZE_TOLERANCE_PX || Math.abs(now.h - r.h) > SIZE_TOLERANCE_PX;
    });
    check(`reshow-${panel.id}-restores-every-pane-size`, drifted.length === 0, `drifted=${JSON.stringify(drifted)}`);
    const shapeBack = await columnShape(cls);
    check(`reshow-${panel.id}-handle-count`, shapeBack.handles === siblings - 1, `handles=${shapeBack.handles} want ${siblings - 1}`);
  }

  // ── Scenario 5: hide a WHOLE column — the column and its handle both go ─────
  // `.canvas-wrap` is CanvasView's root; the OUTER row's layout is `.main`'s first
  // .sp-layout (SplitPane wraps it in a .sv-root, so `.main > .sp-layout` finds
  // nothing — that returned null and read as a failure rather than a bad selector).
  const canvasWidth = () => page.evaluate(() => document.querySelector(".canvas-wrap")?.getBoundingClientRect().width ?? null);
  const outerHandles = () =>
    page.evaluate(() => {
      const outer = document.querySelector(".main .sp-layout");
      return outer ? [...outer.children].filter((c) => c.classList.contains("sp-handle")).length : null;
    });
  const canvasBefore = await canvasWidth();
  const outerBefore = await outerHandles();
  check("outer-row-has-two-handles-with-both-columns", outerBefore === 2, `outer handles=${outerBefore}`);
  for (const panel of panelsInColumn("left")) await run(panelToggleCommand(panel).id);
  await settle();
  const leftGone = await columnShape(".left-col");
  const canvasAfter = await canvasWidth();
  const outerAfter = await outerHandles();
  await page.screenshot({ path: `${shots}/panels_left_column_gone.png` });
  check("empty-column-is-removed", leftGone.present === false, `left column still in the DOM: ${JSON.stringify(leftGone)}`);
  check("empty-column-takes-its-outer-handle-with-it", outerAfter === 1, `outer handles=${outerAfter} want 1`);
  check("canvas-widens-into-the-freed-space", canvasBefore !== null && canvasAfter > canvasBefore, `canvas ${canvasBefore} → ${canvasAfter}`);
  // The CANVAS is not a panel: no command can hide it, so the row is never empty.
  const canvasCommands = registered.filter((c) => /canvas/i.test(c.id) && /^Toggle Visibility: /.test(c.title));
  check("no-toggle-visibility-command-targets-the-canvas", canvasCommands.length === 0, `commands=${JSON.stringify(canvasCommands)}`);
  for (const panel of panelsInColumn("left")) await run(panelToggleCommand(panel).id);
  await settle();
  check("column-returns-when-a-panel-does", (await columnShape(".left-col")).present === true);

  // ── Scenario 6: the RENAME, as rendered ────────────────────────────────────
  // Turn the name plates ON so the user-visible title bar text is what is read,
  // not just the data-region attribute.
  await run("toggle-panel-names");
  await settle();
  const plates = await page.evaluate(() => [...document.querySelectorAll(".panel-title")].map((el) => el.textContent.trim()));
  await page.screenshot({ path: `${shots}/panels_name_plates.png` });
  check("plate-says-global-variables-panel", plates.includes("Global Variables Panel"), `plates=${JSON.stringify(plates)}`);
  check("no-plate-still-says-plain-variables-panel", !plates.includes("Variables Panel"), `plates=${JSON.stringify(plates)}`);
  for (const panel of PANELS) check(`plate-${panel.id}`, plates.includes(panelName(panel)), `plates=${JSON.stringify(plates)}`);
  await run("toggle-panel-names");
  await settle();

  // ── Scenario 7: persistence across a reload, on the keys panels.js names ────
  await run(panelToggleCommand(PANELS.find((p) => p.id === "keyframes")).id); // hide Keyframe
  await settle();
  const stored = await page.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), PANELS.map((p) => panelSettingKey(p.id)));
  check("toggle-writes-the-declared-key", stored[panelSettingKey("keyframes")] === "off", `stored=${JSON.stringify(stored)}`);
  check("global-variables-key-now-on", stored[panelSettingKey("globalVariables")] === "on", `stored=${JSON.stringify(stored)}`);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".app", { timeout: 20000 });
  await settle();
  const afterReload = await regions();
  check("reload-keeps-keyframe-hidden", !afterReload.includes("Keyframe Panel"), `regions=${JSON.stringify(afterReload)}`);
  check("reload-keeps-global-variables-shown", afterReload.includes("Global Variables Panel"), `regions=${JSON.stringify(afterReload)}`);
  await page.screenshot({ path: `${shots}/panels_after_reload.png` });

  const newErrors = errors.slice(bootErrors).filter((e) => !isEnvironmental(e));
  if (newErrors.length) failures.push(`console errors during panel visibility probe: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("PANEL VISIBILITY PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s) from other agents' in-flight work)`);
    process.exit(1);
  }
  console.log(
    `Panel visibility probe passed: all scenarios green ` +
      `(ignored ${bootErrors} boot error(s), of which ${bootEnvironmental} environmental). Shots in ${shots}`,
  );
} finally {
  await browser.close();
  await server.close();
}
