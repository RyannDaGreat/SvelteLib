/**
 * TOOL SURFACING gate — "a widget-scoped command reaches the Tools pane", checked
 * in BOTH directions against a LIVE registry.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/tool_surfacing_probe.js
 *
 * WHY THIS EXISTS. The user, verbatim: *"Shatter is delivered and yet I don't see
 * it in the tools panel. Why is there no tool called shatter? Why do I have to open
 * the command palette to find these things? If there's anything that I can do —
 * like duplicate or delete or something — they should show up in the Tools section,
 * but they're not there. All I see is 'bind position and size to camera'."*
 *
 * He was right, and MEASURED at the time: 154 top-level commands were registered,
 * ~40 of them acted on the selection, and the Tools pane surfaced FIVE. The pool in
 * core/registry.js was a hand-written list of command ids — a mirror of the command
 * registry that nothing compared against it, so a command could be born, wired,
 * shortcut and shipped without ever reaching the pane, and no test could tell.
 *
 * A gate landed hours earlier asserted that every pool id IS a registered command.
 * That is the direction that CANNOT catch this: a mirror with five entries names
 * five real commands and passes forever. THE MISSING DIRECTION IS THIS FILE.
 *
 * ── THE INCLUSION RULE, AND WHY IT IS THIS ONE ──────────────────────────────
 * A command belongs in the Tools pane iff ITS AVAILABILITY DEPENDS ON THE
 * SELECTION.
 *
 * It is not asserted, it is MEASURED: the gate is evaluated under several
 * selection states and the command is selection-scoped iff the answers differ.
 * That matters, because every alternative rule is unobservable or arbitrary.
 * "Acts on the selection" lives inside `run` and cannot be read; "is a widget
 * thing" is taste; a hand-kept list of tool ids is the very defect being removed.
 * Whether a gate reads the selection is a fact about the running app, and it
 * coincides exactly with the property the pane needs anyway — a pane row must be
 * greyed by that gate, so a command whose gate ignores the selection would render
 * identically no matter what you had selected, which is what makes it a document
 * or navigation command rather than a tool.
 *
 * It also settles the boundary cases without argument. Save, Open, Export, New
 * Slide, Present, Undo and the 46 Add-widget commands are all invariant under the
 * selection, so none of them can leak in and turn the pane into a second command
 * palette. Paste is invariant too (it has no gate at all) and is correctly out,
 * even though Copy is in — Copy needs something selected and Paste does not.
 *
 * ONE STRUCTURAL EXCLUSION, applied before the rule: a SUBMENU and its children.
 * A pane row cannot be a submenu, because the pane has exactly ONE disclosure
 * level by user ruling ("a drop-down inside a drop-down is stupid") — the group
 * accordion IS the drop-down. So `copy-property` and its 582 per-property children
 * are out on the shape of the surface, not on a judgement about what they do. That
 * is 583 of the 634 gated entries, which is why the exclusion is stated as a rule
 * here rather than buried as an exemption list below.
 *
 * ── WHAT THE RULE CANNOT SEE, measured while proving this file red ──────────
 * A gate that answers FALSE in every probed state is invariant, so the rule does
 * not classify it as selection-scoped — even when it plainly is. SHATTER is the
 * live example and it is the user's own headline case: `shatterBlocker()` returns
 * a reason string until the widget has finished rendering, so a freshly inserted
 * mermaid diagram never reaches available inside a probe. Running this file at
 * HEAD-before-the-fix, the rule listed 35 unreachable commands and shatter was NOT
 * among them.
 *
 * THAT is why the three tools the user named are ALSO checked by hand at the
 * bottom. A rule can be satisfied in general and still miss the instance that
 * prompted it, and a gate which passes for the case that caused the complaint is
 * not a gate. Widening the rule to "false everywhere is also suspicious" was
 * considered and rejected: `unbind-from-camera` is legitimately false in every
 * probed state too, so it would fire on correct code.
 *
 * ── EXEMPTIONS ──────────────────────────────────────────────────────────────
 * Listed below with a reason each, because an exemption with no reason is just a
 * smaller version of the hand-curated list this file exists to abolish.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

/**
 * Commands whose availability DOES follow the selection but which are not tools.
 * Each entry is a reason, and the set is asserted to be exactly used — an
 * exemption for a command that no longer needs one is a stale excuse, so this
 * file fails on that too.
 */
const NOT_A_TOOL = {
  deselect: "manages the SELECTION rather than acting on it — a row that empties the pane it lives in is a category error",
  "deselect-all": "same: selection management, not a widget operation",
};

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const browser = await launchBrowser();
const failures = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // The dep-optimizer re-runs whenever a sibling agent saves a file, and it easily
  // outruns puppeteer's 30 s default — that is a shared-tree artifact, not a
  // failure of this app, so wait for the app hook rather than for the network.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 800));

  const check = (name, cond, detail = "") => {
    if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  };

  const result = await page.evaluate(() => {
    const app = window.__powerrp_app;

    // EVERY command a widget could ever be offered: the union over the whole
    // registered roster of each plugin's RESOLVED tool groups. Derived from the
    // live registry, so a plugin that declares its own group counts exactly as a
    // pool row does — the pane reads both and this must too.
    const surfaced = new Set();
    for (const plugin of app.registry.all())
      for (const group of plugin.toolGroups ?? [])
        for (const row of group.rows)
          if (row.kind === "command") surfaced.add(row.command);

    // ── the selection states the gates are probed under ──────────────────────
    // Enough kinds of selection that a gate keyed to ANY of them varies: nothing,
    // one plain widget, two (align/distribute/group), one widget of every
    // registered type (so a type-specific gate such as shatter's or the code
    // editor's is reached), and a selected HANDLE (the point tools' inner scope).
    const original = app.selectedIds();
    const setNone = () => { app.selection = null; };
    const insert = (type) => {
      const p = app.registry.get(type);
      app.addItem({ ...p.defaults, type, x: 120, y: 120, w: 200, h: 150 });
      return app.selection;
    };

    const states = [];
    states.push(() => setNone());
    const a = insert("rect");
    const b = insert("circle");
    states.push(() => { app.selection = a; });
    states.push(() => { app.selectMany([a, b]); });
    // One of every registered type, inserted and selected alone. This is what
    // makes the sweep total rather than a sample: shatter is offered on exactly
    // one plugin today, and a probe that only ever selected a rect could not tell
    // a correctly-scoped tool from a dead one.
    const perType = [];
    for (const plugin of app.registry.all()) {
      if (plugin.capabilities?.purgeable === false) continue; // THE camera: a singleton, cannot be added
      let id = null;
      try { id = insert(plugin.type); } catch (e) { perType.push(`${plugin.type}: ${e.message}`); continue; }
      if (id) states.push(() => { app.selection = id; });
      if (plugin.type === "polygon" || plugin.type === "paint_path") {
        // …and with one of its HANDLES selected, the point tools' scope.
        states.push(() => {
          app.selection = id;
          const h = app.handles()[0];
          if (h) app.selectHandle(h.id);
        });
      }
    }

    // ── measure: does this gate's answer move with the selection? ────────────
    // TOP-LEVEL, RUN-BEARING entries only — a submenu cannot be a pane row and
    // neither can something reachable only by drilling into one (see the header).
    const submenuChildren = new Set(app.commands.all().flatMap((c) => (c.children ?? []).map((k) => k.id)));
    const entries = app.commands.all().filter((c) =>
      typeof c.when === "function" && !c.children && !submenuChildren.has(c.id));
    const selectionScoped = [];
    const gateErrors = [];
    const answers = new Map(entries.map((c) => [c.id, []]));
    for (const enter of states) {
      enter();
      for (const c of entries) {
        let v;
        try { v = !!c.when(app); } catch (e) { gateErrors.push(`${c.id}: ${e.message}`); v = "threw"; }
        answers.get(c.id).push(v);
      }
    }
    for (const c of entries)
      if (new Set(answers.get(c.id)).size > 1) selectionScoped.push(c.id);

    // Forward direction, on the live registry: a surfaced command that CAN be
    // greyed must be able to say why.
    const surfacedNoReason = [];
    for (const id of surfaced) {
      const cmd = app.commands.get(id);
      if (cmd.when && cmd.requires === undefined) surfacedNoReason.push(id);
    }

    setNone();
    if (original.length) app.selectMany(original);
    return {
      surfaced: [...surfaced].sort(),
      selectionScoped: selectionScoped.sort(),
      surfacedNoReason,
      gateErrors: [...new Set(gateErrors)],
      totalCommands: app.commands.all().length,
      gatedCommands: entries.length,
      insertFailures: perType,
    };
  });

  console.log(`  commands: ${result.totalCommands} registered, ${result.gatedCommands} gated, `
    + `${result.selectionScoped.length} selection-scoped, ${result.surfaced.length} surfaced as tools`);
  if (result.insertFailures.length)
    console.log(`  (widgets that could not be inserted for probing: ${result.insertFailures.join(" | ")})`);

  // ── THE REVERSE DIRECTION — the one nothing checked ───────────────────────
  const missing = result.selectionScoped.filter((id) => !result.surfaced.includes(id) && !(id in NOT_A_TOOL));
  check("every selection-scoped command reaches the Tools pane", missing.length === 0,
    `${missing.length} unreachable: ${missing.join(", ")}`);

  // An exemption nobody needs any more is a stale excuse for a list that has
  // moved on — so the exemptions are asserted to be live, not merely allowed.
  const staleExemptions = Object.keys(NOT_A_TOOL).filter((id) => !result.selectionScoped.includes(id));
  check("no stale exemption", staleExemptions.length === 0,
    `${staleExemptions.join(", ")} — no longer selection-scoped, so delete the exemption`);
  const exemptButSurfaced = Object.keys(NOT_A_TOOL).filter((id) => result.surfaced.includes(id));
  check("an exempted command is not ALSO surfaced", exemptButSurfaced.length === 0, exemptButSurfaced.join(", "));

  // ── THE FORWARD DIRECTION — kept, but asked of the live registry ──────────
  check("every gated tool declares a requires sentence", result.surfacedNoReason.length === 0,
    result.surfacedNoReason.join(", "));

  // ── VACUITY GUARDS. A sweep that measured nothing passes everything. ──────
  check("the sweep found a substantial set of selection-scoped commands", result.selectionScoped.length >= 25,
    `only ${result.selectionScoped.length} — the state probe is not varying the selection enough`);
  check("no gate threw while being probed", result.gateErrors.length === 0, result.gateErrors.join(" | "));
  // The three the user named by hand. Named explicitly BECAUSE they are what he
  // asked for: a rule can be satisfied in the abstract and still miss the case
  // that prompted it.
  for (const id of ["shatter", "duplicate", "delete-item"])
    check(`the user's named tool "${id}" is surfaced`, result.surfaced.includes(id));
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\ntool surfacing probe: all checks passed");
