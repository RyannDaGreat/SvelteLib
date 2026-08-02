/**
 * SELECTION SET OPERATIONS (#301) — invert, invert-in-group, and select /
 * deselect by widget type with a previewing submenu.
 *
 * User: "Invert selection and invert selection within group should be additional
 * commands… We should also have a command for select by type… and deselect by
 * type, which would be — well, it's command-palette only, and we'll give you a
 * submenu in the command palette that lets you search for a given type. And of
 * course, as you scroll up and down, it would preview what it would look like."
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

      // Opening the palette is what triggers the submenu-refresh effect; the wait
      // for it happens on the NODE side, below.
      app.deselectAll();
      app.paletteOpen = true;
      return out;
    });
    await new Promise((res) => setTimeout(res, 200)); // let the refresh effect run

    const rest = await page.evaluate((rects) => {
      const app = window.__powerrp_app;
      const out = {};
      const sub = app.commands.get("select-by-type");
      out.subPresent = !!sub;
      out.subIsSubmenu = Array.isArray(sub?.children) && !sub?.run;
      out.subChildren = (sub?.children ?? []).map((c) => c.title);
      const rectChild = (sub?.children ?? []).find((c) => c.id === "select-type-rect");
      out.rectChildTitle = rectChild?.title ?? null;

      // PREVIEW then UNDO — the hover behaviour.
      const before = [...app.selectedIds()];
      const undo = rectChild.preview(app);
      out.previewSelected = app.selectedIds().length;
      undo();
      out.previewRestored = JSON.stringify([...app.selectedIds()]) === JSON.stringify(before);

      rectChild.run(app);
      out.byTypeSelected = app.selectedIds().length;
      const desub = app.commands.get("deselect-by-type");
      desub.children.find((c) => c.id === "deselect-type-rect").run(app);
      out.afterDeselect = app.selectedIds().length;

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
      // LEAVE THE APP QUIET. The palette was opened above to trigger the submenu
      // refresh effect, and leaving it open means Svelte effects are still
      // scheduled when the harness tears the browser down — which rejected the
      // outstanding evaluate as "Promise was collected" and made this probe EXIT 1
      // WHILE EVERY CHECK PASSED. A probe that reports failure after passing is
      // worse than one that fails: it reads as a real red in the gate.
      app.paletteOpen = false;
      return out;
    }, first.rects);
    const r = { ...first, ...rest };

    ok(r.invertHasCircles && r.invertDroppedRects, "INVERT: the unselected become selected and vice versa");
    ok(r.invertOfNothingIsAll, "inverting NOTHING selects everything — the complement of the empty set");
    ok(r.subPresent && r.subIsSubmenu, "select-by-type is a SUBMENU (run XOR children), because parameterised palette commands are banned");
    ok(r.subChildren.length > 0, `its children are built from the live slide (${r.subChildren.join(", ")})`);
    ok(/\(3\)$/.test(r.rectChildTitle ?? ""), `each child COUNTS what it would take — "${r.rectChildTitle}"`);
    ok(r.previewSelected === 3, `HOVER PREVIEWS: the entry stages its selection (${r.previewSelected} items)`);
    ok(r.previewRestored, "…and moving off restores exactly what was selected before");
    ok(r.byTypeSelected === 3, `SELECT BY TYPE took all 3 rects (${r.byTypeSelected})`);
    ok(r.afterDeselect === 0, `DESELECT BY TYPE subtracts them again (${r.afterDeselect})`);
    ok(r.inGroupGate === true, "invert-in-group is available while inside a group");
    ok(r.inGroupFlipped, "INVERT IN GROUP: the other two members are selected, the held one is not");
    ok(r.inGroupStayedInside, "…and it never reaches outside the group");
    ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors.slice(0, 3).join(" | ")}` : ""}`);

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
