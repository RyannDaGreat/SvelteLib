/**
 * PALETTE HOVER PROBE (workstream PALETTE_, backburner DW) — hovering the
 * command palette must raise NO page error, and a row that throws from its
 * hover preview must cost one error per entry rather than a runaway effect.
 *
 * ── THE REPORT (user, 2026-08-12, prod bundle index-CysiSHpk) ────────────────
 *   "BUG: this happens before I even add a node, just hovering over the command
 *    palette: Uncaught Error: https://svelte.dev/e/effect_update_depth_exceeded"
 * — pasted together with a SECOND error, a demo patch whose node had no knob
 * "p1", thrown out of a command. That pairing is the clue this probe encodes:
 * the palette runs arbitrary command code ON HOVER (the previewable-command
 * protocol), so a command that throws and a reactive loop are the same incident
 * seen from two sides.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 * HOVERING ANY PALETTE ROW — INCLUDING EVERY ROW WHOSE `preview` WRITES STATE
 * THE PALETTE ITSELF READS — MUST RAISE NO PAGE ERROR. Scenarios 1-2 sweep the
 * default rows and then the previewable ones (bind-to-camera writes
 * previewDelta; the by-type PICKER's options write the selection), with a
 * retrace, because a loop needs a re-entry to start. Scenario 3 adds a row that
 * THROWS from preview(), the tripwire for a throw landing inside such a loop.
 *
 * ── WHAT THIS PROBE ORIGINALLY GUARDED, AND WHAT REPLACED IT (R7-42) ────────
 * It was written around ONE specific hazard: web/App.svelte's paletteOpen effect
 * called refreshTypeSelectCommands, which read nodes(), and nodes() registers
 * `doc`, `previewDelta`, `slideIndex` and `assetsVersion` UNCONDITIONALLY BY
 * DESIGN (app.svelte.js:1421 says so in as many words). Tracked, that effect
 * subscribed to previewDelta while its body SPLICED the very children arrays the
 * palette's `results` derived walks — so hovering a row whose preview wrote
 * previewDelta or the selection re-dirtied the effect that rebuilt the rows under
 * the cursor. f4b11012 fixed it with `untrack`.
 *
 * THAT EFFECT NO LONGER EXISTS. The user's ruling collapsed the N minted by-type
 * commands into two static ones whose type argument is gathered by the palette's
 * PICKER STAGE, so there is no per-document command roster left to rebuild and
 * nothing to untrack — the cycle is now unexpressible rather than suppressed
 * (tests/select_by_type_command_test.js is the structural pin on that). This
 * probe is therefore no longer a fence around one `untrack` call; it is what it
 * always also was, a STANDING GUARD over the hover path, now driven over the
 * two-stage flow. Scenario 2 enters the picker rather than drilling a submenu.
 *
 * ── AN HONEST NOTE ON WHAT THIS PROBE DOES AND DOES NOT PROVE ───────────────
 * The user's exact crash was NOT reproduced at any commit available here — not
 * in dev, not in a prod build, and not at origin/powerrp (d8f59104), the
 * deployed commit, whose bundle hash does not match the reported one either. So
 * this probe is a STANDING GUARD over the hover path, not a red-to-green witness
 * for that report. It was measured NOT to bite on the untrack alone (see that
 * round's report); it exists because the palette runs arbitrary command code on
 * hover and nothing else asserted that path was error-free. That remains exactly
 * as true of the picker stage, which runs `onPreview` on the same hover.
 *
 * Errors are ASSERTED, never left as an unread log line — the discipline
 * tests/prod_boot_probe.js exists to enforce. Boot-time noise from other agents'
 * in-flight WIP is baselined first (the modal_xform_probe.js convention).
 *
 * Run from the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/palette_hover_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const repo = process.cwd();
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

const SETTLE_MS = 1500; // generous: a real loop trips Svelte's guard within a frame or two

const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures.push(`${name}${detail ? `: ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr:false + watch:null — the house probe convention: a concurrent save
  // anywhere in the tree would otherwise reload the page mid-run.
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const { launchBrowser } = await import(resolve(HERE, "puppeteerLaunch.js"));
const browser = await launchBrowser();
const errors = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(e.stack || e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__powerrp_app, { timeout: 120000, polling: 500 });
  await new Promise((r) => setTimeout(r, 1500));
  const boot = errors.length; // baseline: other agents' in-flight WIP, not ours
  console.log(`boot baseline: ${boot} error(s)`);

  const openPalette = async (query) => {
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate((q) => {
      const i = document.querySelector(".palette input");
      i.value = q;
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }, query);
    await new Promise((r) => setTimeout(r, 300));
  };
  const visibleRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".palette-item")]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.commandId, x: r.x + r.width / 2, y: r.y + r.height / 2, vis: r.top > 0 && r.bottom < innerHeight };
        })
        .filter((r) => r.vis),
    );
  // Two moves per row: browsers fire pointermove only on genuine movement, and
  // the palette highlights on pointerMOVE (not pointerenter) by design.
  const hover = async (row, jitter = 0) => {
    await page.mouse.move(row.x - 6, row.y + jitter);
    await page.mouse.move(row.x, row.y + jitter);
    await new Promise((r) => setTimeout(r, 90));
  };

  // ── Scenario 1: the plain sweep the user describes — ≥10 entries, no errors ─
  console.log("\nScenario 1: pointermove across the default palette rows");
  await openPalette("");
  const rows1 = await visibleRows();
  check("default-palette-has-rows", rows1.length >= 10, `only ${rows1.length} visible`);
  const before1 = errors.length;
  for (const row of rows1) await hover(row);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  check("plain-hover-sweep-raises-no-error", errors.length === before1,
    errors.slice(before1).map((e) => e.split("\n")[0]).join(" | "));

  // ── Scenario 2: the rows whose preview WRITES state the gates read ─────────
  // bind-to-camera / unbind write previewDelta; the by-type PICKER's options
  // write the selection. Both are the loop's closing link, so they are hovered
  // explicitly (and re-hovered, since a loop needs a transition to start).
  // The selection is what `partitionByAvailability` asks every row's `when`
  // about, so a preview that writes it is re-partitioning the list under the
  // cursor — the same shape as the old rebuild, reached through the picker now.
  console.log("\nScenario 2: previewable rows (previewDelta + selection writers)");
  await page.evaluate(() => {
    const a = window.__powerrp_app;
    a.selectMany(a.nodes().slice(0, 3).map((n) => n.itemId));
  });
  const before2 = errors.length;
  for (const q of ["bind", "select", "theme"]) {
    await openPalette(q);
    const rows = await visibleRows();
    for (const row of rows) await hover(row);
    // retrace upward: re-entering a row is what re-runs the preview effect
    for (const row of [...rows].reverse()) await hover(row, 1);
    // drill into the first container found at this query and sweep its children
    const drilled = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".palette-item")].find((e) => e.querySelector(".sub-arrow"));
      if (!el) return null;
      const id = el.dataset.commandId;
      el.click();
      return id;
    });
    if (drilled) {
      await new Promise((r) => setTimeout(r, 300));
      const kids = await visibleRows();
      for (const row of kids) await hover(row);
      for (const row of [...kids].reverse()) await hover(row, 1);
      console.log(`  · drilled ${drilled} (${kids.length} rows)`);
    }
  }

  // ── Scenario 2b: THE PICKER STAGE, hovered the same way (R7-42) ────────────
  // Its options' onPreview writes the SELECTION, which every row's `when` is
  // asked about — the selection-writing half of the old by-type children, now
  // one stage in. Reached the way a user reaches it (run the command, then
  // hover the options), not by calling the spec, because what is under test is
  // the palette's own effect graph.
  for (const cmd of ["select-by-type", "deselect-by-type"]) {
    // CLOSE FIRST, ALWAYS. Scenario 2 leaves the palette DRILLED INTO a submenu,
    // and openPalette() only sets paletteOpen — already true, so the reset effect
    // (which clears the query and the stack) never refires and search() stays
    // scoped to that submenu's children. The by-type rows then legitimately do
    // not exist at that level, and the probe skipped both silently. Measured: the
    // same query lists them at the top level.
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
    await new Promise((r) => setTimeout(r, 150));
    await openPalette("by widget type");
    const entered = await page.evaluate((id) => {
      const el = [...document.querySelectorAll(".palette-item")].find((e) => e.dataset.commandId === id);
      if (!el) return false;
      el.click();
      return true;
    }, cmd);
    // A SKIP IS A FAILURE HERE, not a note. An earlier draft logged "not offered
    // — skipped" and passed; the row was in fact absent because the palette was
    // still drilled into another submenu, so the entire picker sweep silently did
    // nothing while the probe reported green.
    check(`picker-command-offered:${cmd}`, entered, "the command row was not in the palette — the sweep below tested nothing");
    if (!entered) continue;
    await new Promise((r) => setTimeout(r, 300));
    const opts = await visibleRows();
    check(`picker-has-options:${cmd}`, opts.length > 0, "the picker stage rendered no option rows");
    for (const row of opts) await hover(row);
    for (const row of [...opts].reverse()) await hover(row, 1);
    console.log(`  · picker ${cmd} (${opts.length} options)`);
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  check("previewable-hover-raises-no-error", errors.length === before2,
    errors.slice(before2).map((e) => e.split("\n")[0]).join(" | "));
  check("no-effect-update-depth-exceeded",
    !errors.slice(boot).some((e) => /effect_update_depth_exceeded/.test(e)),
    "the reported crash sentence appeared");

  // ── Scenario 3: a throwing preview is loud ONCE, not on every re-run ───────
  console.log("\nScenario 3: a row whose preview() throws");
  await page.evaluate(() => {
    const a = window.__powerrp_app;
    a.commands.add({ id: "zzprobe-safe", title: "ZZPROBE Safe Row", icon: "mdi:check", preview: () => () => {}, run: () => {} });
    a.commands.add({
      id: "zzprobe-throw",
      title: "ZZPROBE Throwing Row",
      icon: "mdi:bug",
      // The shipped shape of this: a demo patch naming a knob its spec dropped.
      preview: () => { throw new Error("ZZPROBE: preview throws on purpose"); },
      run: () => {},
    });
  });
  // The registry is a PLAIN structure (core/commands.js) — `results` re-reads it
  // only when `app.paletteOpen` flips, which is exactly what its docblock says
  // the paletteOpen read is for. So a row added while the palette is open is
  // invisible until it is closed and reopened; close first, then open.
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
  await new Promise((r) => setTimeout(r, 200));
  await openPalette("ZZPROBE");
  const probeRows = await visibleRows();
  const safe = probeRows.find((r) => r.id === "zzprobe-safe");
  const bad = probeRows.find((r) => r.id === "zzprobe-throw");
  if (!safe || !bad) {
    const diag = await page.evaluate(() => ({
      registered: window.__powerrp_app.commands.all().filter((c) => c.id.startsWith("zzprobe")).map((c) => c.id),
      searched: window.__powerrp_app.commands.search("ZZPROBE", null).map((c) => c.id).slice(0, 8),
      inputValue: document.querySelector(".palette input")?.value ?? null,
      domRows: [...document.querySelectorAll(".palette-item")].map((e) => e.dataset.commandId).slice(0, 8),
    }));
    console.log("  DIAG:", JSON.stringify(diag));
  }
  check("probe-rows-surfaced", !!safe && !!bad, probeRows.map((r) => r.id).join(", "));

  if (safe && bad) {
    await hover(safe); // latch previewedId on a good row first
    await new Promise((r) => setTimeout(r, 300));
    const before3 = errors.length;
    // Re-enter the row repeatedly, the way a user browsing back and forth does.
    // Each ENTRY legitimately runs preview() once and so throws once — that is
    // the contract (loud, not swallowed). What must NOT happen is the reactive
    // scheduler giving up: a throwing preview inside a tracked rebuild loop is
    // how one bad row turns into effect_update_depth_exceeded.
    const ENTRIES = 7;
    await hover(bad);
    for (let i = 1; i < ENTRIES; i += 1) {
      await hover(safe, i % 2);
      await hover(bad, i % 2);
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const raised = errors.slice(before3).filter((e) => /ZZPROBE: preview throws on purpose/.test(e));
    // Loud: the throw must be reported, not swallowed (no silent fallbacks).
    check("throwing-preview-is-reported", raised.length >= 1, "the throw was swallowed");
    // BOUNDED BY THE GESTURE: one report per entry, not per effect re-run. A
    // tracked rebuild re-runs the preview effect many times per hover, so a
    // regression there shows up here as a count far above the entry count.
    check("throwing-preview-is-bounded-by-entries", raised.length <= ENTRIES,
      `raised ${raised.length} times for ${ENTRIES} entries`);
    check("throwing-preview-raises-no-depth-error",
      !errors.slice(before3).some((e) => /effect_update_depth_exceeded/.test(e)));

    // And the palette stays usable: moving back to a good row still previews.
    const before4 = errors.length;
    await hover(safe, 1);
    await new Promise((r) => setTimeout(r, 400));
    check("palette-still-usable-after-a-throw",
      !errors.slice(before4).some((e) => /ZZPROBE/.test(e)),
      "the bad row kept throwing after the cursor left it");
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures.length ? `FAILED (${failures.length})` : "PASSED"} — palette_hover_probe`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
