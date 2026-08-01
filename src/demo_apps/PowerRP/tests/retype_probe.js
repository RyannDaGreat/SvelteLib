/**
 * RETYPE PROBE — the Inspector's widget-type selector, driven in a real browser.
 *
 * The node suites (retype_test.js, retype_sweep_test.js) already own every RULE:
 * which values carry, which coerce, which types are excluded, and that no pair
 * escapes the emit containment. This probe covers only what a node test
 * structurally cannot see — that the rules reach the SCREEN:
 *
 *   1. A retypeable item's header IS a dropdown, and the camera's is NOT (the
 *      exclusion predicate, rendered).
 *   2. Choosing a type actually retypes: the document's type changes, the
 *      INSPECTOR ROWS swap to the new plugin's, and the canvas repaints. Row
 *      swapping is the half that only exists in the DOM — the node tests can
 *      prove the state changed but not that the panel followed it.
 *   3. Undo restores the old type AND the old rows, in ONE press. The command
 *      writes a type keyframe plus N fill/coercion keyframes, so "one undo unit"
 *      is a claim about how they were committed, and this is where it is checked
 *      end to end.
 *   4. THE WARNING AFFORDANCE, which is the user ruling this feature turns on:
 *      a clean target carries no warning chrome; a coercing target is sorted to
 *      the bottom, tinted red, carries the triangle icon, and hovering it shows
 *      a tooltip whose first line is the bold warning and whose bullets name the
 *      exact properties with their from → to values. The tooltip's CONTENT is
 *      asserted against the same coercionPreview the command reads, so a probe
 *      failure means the UI and the rules disagree — not that a string moved.
 *
 * Fails loudly on any NEW console error; boot noise from other agents' in-flight
 * WIP is recorded as a baseline and ignored (the house convention).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/retype_probe.js <shot_dir>
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
// The gate passes a shot dir that may not exist yet; a screenshot into a missing
// directory throws ENOENT and kills the run AFTER the real assertions have
// already passed, reporting a filesystem accident as a probe failure.
const shots = process.argv[2] ?? "/tmp";
await mkdir(shots, { recursive: true });

const SETTLE_MS = 150; // one Svelte flush + a repaint; the house probe's dwell

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr:false + watch:null — the house probe convention. Without it a concurrent
  // save anywhere in the tree reloads the page mid-run and every later evaluate
  // dies with "Execution context was destroyed".
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await launchBrowser();
const failures = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));

  const bootErrors = errors.length; // baseline: other agents' in-flight WIP, not ours
  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };
  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  /** Query. Selects an item by id and waits for the Inspector to follow. */
  const select = async (itemId) => {
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, itemId);
    await settle();
  };
  const typeOf = (itemId) => page.evaluate((id) => window.__powerrp_app.state().items[id].type, itemId);
  /** Query. The Inspector's rendered property-row labels — the "rows swapped" evidence. */
  const rowLabels = () => page.evaluate(() => [...document.querySelectorAll(".inspector .row .label")].map((e) => e.textContent.trim()));
  // THE WIDGET-TYPE CONTROL IS AN ORDINARY PROPERTY ROW (R6-6.6): the panel-wide
  // `.widget-type-picker` div and the `.widget-type` caption it used to be are
  // gone, folded into the Universal section as a select row whose two forms are
  // the shared Dropdown and the row grid's own inert `.disabled-val`. These three
  // queries therefore find the ROW BY ITS LABEL and read what is inside it —
  // everything they assert is unchanged, and the label is the one thing R6-6.3
  // fixes in place ("Rename it 'Widget type'").
  const TYPE_ROW_LABEL = "Widget type";
  /** Query. The Widget type row's dropdown count — 1 when retypeable, 0 when not. */
  const headerPickerCount = () => page.evaluate((lbl) => {
    const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent?.trim() === lbl);
    return row ? row.querySelectorAll(".dd").length : 0;
  }, TYPE_ROW_LABEL);
  /** Query. The inert form's text — the plugin title shown when nothing can be
   *  retyped into. null when the row is a live dropdown instead. */
  const headerCaption = () => page.evaluate((lbl) => {
    const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent?.trim() === lbl);
    return row?.querySelector(".disabled-val")?.value ?? null;
  }, TYPE_ROW_LABEL);
  /** Query. A clickable handle on that row's dropdown trigger, or null. */
  const typeRowTrigger = async () => {
    const rows = await page.$$(".inspector .row");
    for (const row of rows) {
      const label = await row.$eval(".label", (e) => e.textContent.trim()).catch(() => null);
      if (label === TYPE_ROW_LABEL) return row.$(".dd-trigger");
    }
    return null;
  };

  // The demo deck's first non-camera, retypeable item.
  const { rectId, camId } = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const nodes = app.nodes();
    return {
      rectId: nodes.find((n) => n.type === "rect")?.itemId ?? nodes.find((n) => n.type !== "camera").itemId,
      camId: nodes.find((n) => n.type === "camera").itemId,
    };
  });

  // ── 1. THE HEADER IS A DROPDOWN — except where it structurally cannot be ──
  await select(rectId);
  check("retypeable-header-is-a-picker", (await headerPickerCount()) === 1, `the Widget type row holds ${await headerPickerCount()} dropdowns`);
  check("retypeable-header-has-no-caption", (await headerCaption()) === null, `caption was ${JSON.stringify(await headerCaption())}`);

  await select(camId);
  check("camera-header-has-no-picker", (await headerPickerCount()) === 0, "the camera offered a retype dropdown — it is purgeable:false and must not");
  check("camera-header-is-plain-text", (await headerCaption())?.length > 0, `camera caption was ${JSON.stringify(await headerCaption())}`);

  // ── 2. RETYPE THROUGH THE MENU: type changes, rows swap, canvas repaints ──
  await select(rectId);
  const beforeType = await typeOf(rectId);
  const beforeRows = await rowLabels();

  // Pick a CLEAN target from the live menu (the app's own ordering puts them
  // first) so this scenario tests the happy path; the warning path is scenario 4.
  const cleanTarget = await page.evaluate(() => window.__powerrp_app.retypeChoices().find((c) => c.coercions.length === 0 && c.value !== window.__powerrp_app.selectedNode().type)?.value ?? null);
  check("found-a-clean-target", cleanTarget !== null, "the live menu offered no clean target to retype into");

  // Drive it through the DOM, not the app method — the point is that the CONTROL
  // is wired, which an app.retypeSelection() call would bypass entirely.
  const trigger = await typeRowTrigger();
  check("picker-has-a-trigger", !!trigger, "no clickable trigger inside the Widget type row");
  if (trigger && cleanTarget) {
    await trigger.click();
    await settle();
    const clicked = await page.evaluate((label) => {
      const row = [...document.querySelectorAll(".dd-item")].find((e) => e.textContent.trim() === label);
      if (!row) return false;
      row.click();
      return true;
    }, await page.evaluate((t) => window.__powerrp_app.retypeChoices().find((c) => c.value === t).label, cleanTarget));
    check("clicked-a-menu-row", clicked, `no .dd-item matched the target label for "${cleanTarget}"`);
    await settle();

    check("type-changed", (await typeOf(rectId)) === cleanTarget, `type is ${await typeOf(rectId)}, expected ${cleanTarget}`);
    const afterRows = await rowLabels();
    check("rows-swapped", JSON.stringify(afterRows) !== JSON.stringify(beforeRows), "the Inspector rows are identical after a retype — the panel did not follow the type");
    check("rows-non-empty", afterRows.length > 0, "the Inspector rendered no rows after the retype");
    await page.screenshot({ path: `${shots}/retype_after.png` });

    // The canvas must actually repaint as the new widget. A frame that renders
    // at all (non-blank, no thrown paint) is the assertion — pixel identity
    // belongs to the render suites, not here.
    const painted = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      return !!c && c.width > 0 && c.height > 0;
    });
    check("canvas-alive-after-retype", painted, "no live canvas after the retype");

    // ── 3. UNDO IS ONE PRESS ────────────────────────────────────────────────
    await page.evaluate(() => window.__powerrp_app.undo());
    await settle();
    check("undo-restores-type", (await typeOf(rectId)) === beforeType, `after undo type is ${await typeOf(rectId)}, expected ${beforeType}`);
    check(
      "undo-restores-rows",
      JSON.stringify(await rowLabels()) === JSON.stringify(beforeRows),
      "one undo restored the type but not the rows — the fills/coercions were committed as separate undo units",
    );
  }

  // ── 4. THE WARNING AFFORDANCE ─────────────────────────────────────────────
  // ON THE FIXTURE, not the demo deck. A coercion needs two types that declare
  // the same key under DIFFERENT kinds, and that is RARE: measured over the live
  // roster, only 14 of the 91 eligible types coerce into anything at all at their
  // own defaults, and a rect coerces into NOTHING. So a probe that hoped the demo
  // deck's rect would offer a warning was asserting "the warning path is
  // unexercised" and calling it a pass. This inserts a widget chosen because it
  // DOES coerce — a `line`, whose `cap` is a select ("round") that
  // ss_radialSweep's own `cap` select does not offer.
  const fixtureId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const before = new Set(Object.keys(app.state().items));
    app.addItem({ ...app.registry.get("line").defaults, type: "line", x: 200, y: 200, w: 200, h: 100 });
    return Object.keys(app.state().items).find((id) => !before.has(id));
  });
  check("inserted-a-coercing-fixture", !!fixtureId, "could not insert the line fixture the warning scenario needs");
  await select(fixtureId);

  const menu = await page.evaluate(() => window.__powerrp_app.retypeChoices());
  const firstCoercing = menu.findIndex((c) => c.coercions.length > 0);
  check("menu-has-a-coercing-target", firstCoercing !== -1, "the line fixture offered no coercing target — the warning path is unexercised");

  if (firstCoercing !== -1) {
    // Bottom-sorted: every entry from the first coercing one onward coerces.
    check(
      "coercing-targets-are-bottom-sorted",
      menu.slice(firstCoercing).every((c) => c.coercions.length > 0),
      "a clean target sorted BELOW a coercing one — the ruling puts coercing types at the very bottom",
    );

    const trigger2 = await typeRowTrigger();
    await trigger2.click();
    await settle();

    // NO ROW MAY BE ELLIPSIZED. Dropdown constrains the menu to the trigger's
    // width, so a narrow trigger opens a menu too narrow for the roster's longer
    // titles and they render as "Recta…" / "Iconif…". A user cannot pick a type
    // they cannot read, and every assertion above still passed while that was
    // happening — it was only visible in the screenshot, which is exactly why it
    // is pinned here.
    //
    // IT IS MEASURED ON `.dd-item-body`, NOT `.dd-item`, AND THAT IS THE WHOLE
    // ASSERTION. `.dd-item` is the row's flex CONTAINER; the ellipsis lives on
    // `.dd-item-body` inside it (overflow:hidden + text-overflow), so a container
    // whose content overflows a child never reports scrollWidth > clientWidth
    // itself. Measured against the value-column-width menu R6-6.4 produces: the
    // `.dd-item` form returned 0 clipped rows while `.dd-item-body` returned SIX
    // ("Video V5 Scrubber (OffscreenCanvas/worker)", "Brightness / Contrast", …).
    // So this check could not fail for the entire time it was in the gate — the
    // R6-24.4 class, found by giving it something real to catch.
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll(".dd-item-body")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent.trim()),
    );
    check("no-menu-row-is-truncated", clipped.length === 0, `these rows are clipped by the menu width: ${JSON.stringify(clipped)}`);

    // A CLEAN row carries no warning chrome at all.
    const cleanLabel = menu[0].coercions.length === 0 ? menu[0].label : null;
    if (cleanLabel) {
      const cleanChrome = await page.evaluate((label) => {
        const row = [...document.querySelectorAll(".dd-item")].find((e) => e.textContent.trim() === label);
        return row ? { tinted: !!row.querySelector(".retype-coerces"), iconed: !!row.querySelector("iconify-icon") } : null;
      }, cleanLabel);
      check("clean-target-has-no-warning-chrome", cleanChrome && !cleanChrome.tinted && !cleanChrome.iconed, JSON.stringify(cleanChrome));
    }

    // A COERCING row is tinted and carries the triangle on the LEFT of the name.
    const coercing = menu[firstCoercing];
    const warnChrome = await page.evaluate((label) => {
      const row = [...document.querySelectorAll(".dd-item")].find((e) => e.textContent.trim() === label);
      if (!row) return null;
      const tint = row.querySelector(".retype-coerces");
      const icon = tint?.querySelector("iconify-icon");
      return {
        tinted: !!tint,
        icon: icon?.getAttribute("icon") ?? null,
        // "left of the name": the icon is the tinted span's FIRST element child.
        iconIsFirst: !!icon && tint.firstElementChild === icon,
        red: tint ? getComputedStyle(tint).color : null,
      };
    }, coercing.label);
    check("coercing-target-is-tinted", warnChrome?.tinted === true, JSON.stringify(warnChrome));
    check("coercing-target-has-triangle-icon", warnChrome?.icon === "mdi:alert", `icon was ${warnChrome?.icon}`);
    check("triangle-is-left-of-the-name", warnChrome?.iconIsFirst === true, "the warning icon is not the first child — the ruling puts it on the LEFT of the name");

    // THE TOOLTIP: bold first line, then one bullet per coerced property naming
    // the exact from → to values. Asserted against the app's OWN preview, so
    // this cannot pass by matching a hard-coded sentence that has drifted.
    const tip = await page.evaluate(async (label) => {
      const row = [...document.querySelectorAll(".dd-item")].find((e) => e.textContent.trim() === label);
      const target = row?.querySelector(".retype-coerces") ?? row;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      await new Promise((res) => setTimeout(res, 120));
      const tipEl = [...document.querySelectorAll("body > *")].map((e) => e.querySelector?.(".retype-warn-list") ? e : null).find(Boolean)
        ?? document.querySelector(".retype-warn-list")?.closest("div");
      if (!tipEl) return null;
      return {
        bold: tipEl.querySelector("strong")?.textContent?.trim() ?? null,
        bullets: [...tipEl.querySelectorAll(".retype-warn-list li")].map((e) => e.textContent.trim()),
      };
    }, coercing.label);

    check("warning-tooltip-appeared", !!tip, "hovering a coercing target produced no tooltip");
    if (tip) {
      check("tooltip-first-line-is-the-bold-warning", tip.bold === "Warning — types will be coerced", `bold line was ${JSON.stringify(tip.bold)}`);
      const expected = coercing.coercions.map((c) => `${c.label}: ${c.from} → ${c.to}`);
      check(
        "tooltip-bullets-match-the-computed-coercions",
        JSON.stringify(tip.bullets) === JSON.stringify(expected),
        `tooltip listed ${JSON.stringify(tip.bullets)}, the command would coerce ${JSON.stringify(expected)}`,
      );
      check("tooltip-has-at-least-one-bullet", tip.bullets.length > 0, "a coercing target showed a warning with no properties listed");
    }
    await page.screenshot({ path: `${shots}/retype_warning.png` });
    await page.keyboard.press("Escape");
  }

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during the run:\n  ${newErrors.join("\n  ")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`retype_probe FAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("retype_probe: OK");
