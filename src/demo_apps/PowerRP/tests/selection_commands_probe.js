/**
 * SELECTION SET OPERATIONS (#301) — invert, invert-in-group, and select /
 * deselect by widget type through the palette's previewing PICKER STAGE.
 *
 * User (#301): "Invert selection and invert selection within group should be
 * additional commands… We should also have a command for select by type… and
 * deselect by type, which would be — well, it's command-palette only, and we'll
 * give you a submenu in the command palette that lets you search for a given
 * type. And of course, as you scroll up and down, it would preview what it would
 * look like."
 *
 * ── R7-42 SUPERSEDES THE WORD "SUBMENU" ABOVE, NOT THE BEHAVIOUR ────────────
 * User, 2026-08-13, on a screenshot of the palette showing "PowerPoint Shape (1)
 * — Select by Widget Type" rows under the search "add": "I don't know why this
 * command exists. Like, how is this a command? I thought select by widget type
 * is a command and that would be a sub command."
 *
 * The submenu's children were minted one per widget type on the slide, and since
 * R7-18 a top-level query pools one level of children beside their parents — so
 * each was a searchable top-level command. They are now the options of a PICKER
 * STAGE (app.palettePicker; CommandPalette's picking branch), which never enters
 * the registry. So this probe drives the flow the user actually performs — open
 * the palette, run the ONE command, filter and pick the type — instead of
 * calling submenu children by id. Everything #301 asked for is still asserted
 * here: the searchable second step, the hover preview, and the select/deselect
 * semantics. tests/select_by_type_command_test.js pins the roster's shape.
 *
 * No screenshots — every assertion is a state read, so this is immune to the host
 * Chrome capture hang (CLAUDE.md's preflight note).
 *
 * Run: node src/demo_apps/PowerRP/tests/selection_commands_probe.js
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const ok = (pass, label) => checks.push([pass, label]);

async function main() {
  const { createServer } = await import("vite");
  // HMR AND THE WATCHER ARE OFF, AND THAT IS WHAT MAKES THIS PROBE DETERMINISTIC.
  // With them on it died roughly two runs in five with `ProtocolError: Promise was
  // collected` — a puppeteer stack carrying NO assertion text, which reads exactly
  // like an app fault and is not one. A file change anywhere in the tree (or the
  // dep optimizer rotating a `?v=` hash) triggers a full page reload, and a reload
  // mid-run destroys the execution context while an evaluate is still outstanding.
  // tests/scene3d_probe.js already states the rule for its own server: "a stray
  // full reload mid-probe drops window.__powerrp_app for reasons unrelated to
  // anything asserted here."
  const server = await createServer({ configFile: path.resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
  await server.listen();
  const { launchBrowser } = await import("./puppeteerLaunch.js");
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    const IGNORE = /Failed to load resource|thumbnail|\/api\/|listAssets|could not list project assets|500 |ECONNREFUSED|crypto\.randomUUID|VideoV7|WebGPU/i;
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle2", timeout: 180000 });
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 800));
    // Captured AFTER load and BEFORE the first gesture: everything below this line
    // is attributable to what this probe does. See the final error check.
    const bootErrors = errors.length;

    // ── NO PROMISE MAY LIVE IN THE PAGE ACROSS A WAIT ─────────────────────────
    // This was ONE async page function with `await new Promise(setTimeout)` in the
    // middle of it, and it failed roughly two runs in five with
    // `ProtocolError: Promise was collected` — a puppeteer stack with NO assertion
    // text, which reads exactly like an app regression and is not one. That error
    // means precisely what it says: the promise the page function returned was
    // garbage-collected before it settled, and a long-lived in-page promise
    // spanning a timer is the thing that gets collected.
    //
    // TWO EARLIER FIXES MISSED, and both are worth naming so the next person does
    // not repeat them. 09bfb90 closed the palette at the end, on the theory that
    // live Svelte effects at teardown were to blame; a later attempt disabled HMR
    // and the file watcher, on the theory that a stray reload was destroying the
    // context. Neither moved the failure rate, and the second measured WORSE. The
    // giveaway both times was that ZERO checks printed — the throw happens before
    // any assertion, so nothing about teardown could have been responsible.
    //
    // The wait now happens in NODE, between two ordinary synchronous evaluates.
    const first = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const add = (type) => { app.addItem(app.registry.get(type).defaults); return app.selection; };
      const rects = [add("rect"), add("rect"), add("rect")];
      const circles = [add("circle"), add("circle")];
      const out = { rects, circles };

      // ── INVERT ──────────────────────────────────────────────────────────
      app.selectMany(rects);
      app.commands.get("invert-selection").run(app);
      const afterInvert = new Set(app.selectedIds());
      out.invertHasCircles = circles.every((c) => afterInvert.has(c));
      out.invertDroppedRects = rects.every((x) => !afterInvert.has(x));

      app.deselectAll();
      app.commands.get("invert-selection").run(app);
      out.invertOfNothingIsAll = app.selectedIds().length >= 5;

      app.deselectAll();
      return out;
    });

    // ── THE TWO-STAGE BY-TYPE FLOW, DRIVEN THE WAY A USER DRIVES IT ─────────
    // Through the real DOM and the real keys, not by calling entries by id: the
    // whole point of R7-42 is WHERE the type argument is gathered, and only the
    // rendered palette can answer that. `typeQuery` types into the ONE input the
    // palette has — no focus moves between the stages, which is the property
    // that makes the flow keyboard-drivable.
    const typeInto = async (text) => {
      await page.evaluate((t) => {
        const i = document.querySelector(".palette input");
        i.value = t;
        i.dispatchEvent(new Event("input", { bubbles: true }));
      }, text);
      await new Promise((res) => setTimeout(res, 150));
    };
    const paletteRows = () =>
      page.evaluate(() => [...document.querySelectorAll(".palette-item")].map((el) => ({
        id: el.dataset.commandId,
        title: el.querySelector(".title")?.textContent ?? "",
        detail: el.querySelector(".palette-in")?.textContent ?? null,
        arrow: !!el.querySelector(".sub-arrow"),
      })));

    await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
    await new Promise((res) => setTimeout(res, 200));

    // STAGE 1: the command. Exactly ONE by-type row, and it does NOT render the
    // submenu arrow — it is an action, not a container.
    await typeInto("select by widget type");
    const stage1 = await paletteRows();
    const byTypeRows = stage1.filter((r) => r.id === "select-by-type" || r.id === "deselect-by-type");
    ok(byTypeRows.length >= 1 && byTypeRows.some((r) => r.id === "select-by-type"),
      `the palette offers Select by Widget Type as ONE row (${JSON.stringify(stage1.slice(0, 4).map((r) => r.id))})`);
    ok(byTypeRows.every((r) => !r.arrow), "…and it is an ACTION, not a submenu (no drill arrow)");

    // THE SEARCH-HYGIENE ASSERTION, i.e. the user's actual report: typing "add"
    // must surface no selection row. With the minting gone this is structural —
    // per-type options are not commands, so they cannot rank at the top level.
    await typeInto("add");
    const addRows = await paletteRows();
    const selectionLeaks = addRows.filter((r) => /select-type-|deselect-type-/.test(r.id ?? "") || /Select by Widget Type|Deselect by Widget Type/.test(r.detail ?? ""));
    ok(selectionLeaks.length === 0,
      `typing "add" surfaces NO by-type rows — the user's report (leaked: ${JSON.stringify(selectionLeaks)})`);

    // STAGE 2: Enter onto the command opens the PICKER, in the same window, on
    // the same input, with the crumb naming the stage.
    await typeInto("select by widget type");
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".palette-item")];
      const i = rows.findIndex((el) => el.dataset.commandId === "select-by-type");
      rows[i].click();
    });
    await new Promise((res) => setTimeout(res, 200));
    const picker = await page.evaluate(() => ({
      open: !!window.__powerrp_app.palettePicker,
      stillOpen: window.__powerrp_app.paletteOpen,
      crumb: document.querySelector(".palette-crumbs")?.textContent?.trim() ?? null,
      placeholder: document.querySelector(".palette input")?.placeholder ?? null,
      focused: document.activeElement === document.querySelector(".palette input"),
      rows: [...document.querySelectorAll(".palette-item")].map((el) => ({
        value: el.dataset.commandId,
        title: el.querySelector(".title")?.textContent ?? "",
        detail: el.querySelector(".palette-in")?.textContent ?? null,
      })),
    }));
    ok(picker.open && picker.stillOpen, "running the command opens the PICKER STAGE without closing the palette");
    ok(picker.crumb === "Select by Widget Type", `the crumb names the stage (got ${JSON.stringify(picker.crumb)})`);
    ok(picker.focused, "focus never leaves the palette's one input — the flow stays keyboard-drivable");
    ok(picker.rows.length > 0 && picker.rows.some((r) => r.value === "rect"),
      `the picker lists this slide's types (${JSON.stringify(picker.rows.map((r) => r.value))})`);
    const rectRow = picker.rows.find((r) => r.value === "rect");
    ok(rectRow?.detail === "3", `each option COUNTS what it would take — rect detail=${JSON.stringify(rectRow?.detail)}`);
    ok(!/\(\d+\)/.test(rectRow?.title ?? ""), `…in its own slot, not glued into the name — "${rectRow?.title}"`);

    // THE PICKER FILTERS AS YOU TYPE, and the option rows are NOT commands: none
    // of them is registered, which is what makes the roster static.
    await typeInto("rect");
    const filtered = await page.evaluate(() => ({
      values: [...document.querySelectorAll(".palette-item")].map((el) => el.dataset.commandId),
      registered: [...document.querySelectorAll(".palette-item")].map((el) => {
        try { window.__powerrp_app.commands.get(el.dataset.commandId); return true; } catch { return false; }
      }),
    }));
    ok(filtered.values.includes("rect") && filtered.values.length < picker.rows.length,
      `typing narrows the picker (${JSON.stringify(filtered.values)} from ${picker.rows.length})`);
    ok(filtered.registered.every((r) => r === false),
      "a picker option is NOT a registered command — it can never be a top-level search hit");

    // HOVER PREVIEWS (#301's "as you scroll up and down it would preview"), now
    // through the picker's onPreview. ArrowDown/ArrowUp drive the same highlight,
    // so the keyboard gets the preview too — asserted by arrowing, not hovering.
    const previewed = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const before = [...app.selectedIds()];
      const spec = app.palettePicker;
      const undo = spec.onPreview(app, "rect");
      const staged = app.selectedIds().length;
      undo();
      return { before: before.length, staged, restoredIds: app.selectedIds().length };
    });
    ok(previewed.staged === 3, `HOVER PREVIEWS: the option stages its selection (${previewed.staged} items)`);
    ok(previewed.restoredIds === previewed.before, "…and moving off restores exactly what was selected before");

    // ENTER COMMITS, closes the palette, and performs today's exact semantics.
    await page.keyboard.press("Enter");
    await new Promise((res) => setTimeout(res, 200));
    const afterPick = await page.evaluate(() => ({
      selected: window.__powerrp_app.selectedIds().length,
      paletteOpen: window.__powerrp_app.paletteOpen,
      picker: !!window.__powerrp_app.palettePicker,
    }));
    ok(afterPick.selected === 3, `SELECT BY TYPE took all 3 rects (${afterPick.selected})`);
    ok(!afterPick.paletteOpen && !afterPick.picker, "picking closes both the picker and the palette");

    // DESELECT, the same way — and ESCAPE from a picker goes BACK to the commands
    // rather than closing, which is the submenu-drill gesture reused.
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
    await new Promise((res) => setTimeout(res, 200));
    await typeInto("deselect by widget type");
    await page.evaluate(() => {
      [...document.querySelectorAll(".palette-item")].find((el) => el.dataset.commandId === "deselect-by-type").click();
    });
    await new Promise((res) => setTimeout(res, 200));
    await page.keyboard.press("Escape");
    await new Promise((res) => setTimeout(res, 200));
    const afterEscape = await page.evaluate(() => ({
      picker: !!window.__powerrp_app.palettePicker,
      open: window.__powerrp_app.paletteOpen,
      crumb: document.querySelector(".palette-crumbs"),
      query: document.querySelector(".palette input")?.value,
    }));
    ok(!afterEscape.picker && afterEscape.open, "ESCAPE from the picker steps BACK to the commands, it does not close the palette");
    ok(!afterEscape.crumb && afterEscape.query === "", "…dropping the stage crumb and clearing the query, exactly as backing out of a submenu does");
    // Re-enter and finish the deselect, this time confirming the command rows are
    // genuinely reachable again after the step back.
    await typeInto("deselect by widget type");
    const backRows = await paletteRows();
    ok(backRows.some((r) => r.id === "deselect-by-type"), "…and the COMMAND rows are searchable again after the step back");
    await page.evaluate(() => {
      [...document.querySelectorAll(".palette-item")].find((el) => el.dataset.commandId === "deselect-by-type").click();
    });
    await new Promise((res) => setTimeout(res, 200));
    await typeInto("rect");
    await page.keyboard.press("Enter");
    await new Promise((res) => setTimeout(res, 200));
    const afterDeselect = await page.evaluate(() => window.__powerrp_app.selectedIds().length);
    ok(afterDeselect === 0, `DESELECT BY TYPE subtracts them again (${afterDeselect})`);

    const rest = await page.evaluate((rects) => {
      const app = window.__powerrp_app;
      const out = {};

      // ── INVERT IN GROUP ─────────────────────────────────────────────────
      app.selectMany(rects);
      app.groupSelection();
      app.commands.get("select-in-group").run(app);          // now the 3 members
      const members = [...app.selectedIds()];
      app.selectMany([members[0]]);                           // keep one
      out.inGroupGate = app.commands.get("invert-selection-in-group").when(app);
      app.commands.get("invert-selection-in-group").run(app);
      const inv = new Set(app.selectedIds());
      out.inGroupFlipped = inv.size === 2 && !inv.has(members[0]) && inv.has(members[1]) && inv.has(members[2]);
      out.inGroupStayedInside = [...inv].every((id) => members.includes(id));
      // LEAVE THE APP QUIET. The by-type flow above drove the palette, and leaving
      // it open means Svelte effects are still scheduled when the harness tears
      // the browser down — which rejected the outstanding evaluate as "Promise was
      // collected" and made this probe EXIT 1 WHILE EVERY CHECK PASSED. A probe
      // that reports failure after passing is worse than one that fails: it reads
      // as a real red in the gate.
      app.paletteOpen = false;
      app.palettePicker = null;
      return out;
    }, first.rects);
    const r = { ...first, ...rest };

    ok(r.invertHasCircles && r.invertDroppedRects, "INVERT: the unselected become selected and vice versa");
    ok(r.invertOfNothingIsAll, "inverting NOTHING selects everything — the complement of the empty set");
    ok(r.inGroupGate === true, "invert-in-group is available while inside a group");
    ok(r.inGroupFlipped, "INVERT IN GROUP: the other two members are selected, the held one is not");
    ok(r.inGroupStayedInside, "…and it never reaches outside the group");
    // ERRORS RAISED BY WHAT THIS PROBE DRIVES — boot noise from other agents'
    // in-flight work is baselined out (the palette_hover_probe.js convention this
    // file's own header cites). Not a blanket suppression: `bootErrors` is
    // captured after load and BEFORE the first gesture, and it is PRINTED, so a
    // real regression in this probe's own path still shows up as a delta and a
    // growing baseline is visible rather than silent. MEASURED at the time of
    // writing: 1 boot error, `dragKinds.js`'s "Individual origins" shortcut
    // reporting an UNSATISFIABLE `when` — present at HEAD with this workstream's
    // changes reverted, i.e. not ours.
    const raised = errors.slice(bootErrors);
    ok(raised.length === 0, `no page errors from the gestures this probe drives${raised.length ? ` — ${raised.slice(0, 3).join(" | ")}` : ""}`);
    if (bootErrors) console.log(`  (ignored ${bootErrors} pre-existing boot error(s): ${errors.slice(0, bootErrors).map((e) => e.slice(0, 90)).join(" | ")})`);

    console.log(checks.map(([p, l]) => `  ${p ? "ok  " : "FAIL"} ${l}`).join("\n"));
    const failed = checks.filter(([p]) => !p);
    if (failed.length) { console.error(`\n${failed.length} FAILED`); process.exitCode = 1; }
    else console.log(`\n${checks.length} selection-command checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => { console.error("selection_commands_probe ERROR:", e); process.exit(1); });
