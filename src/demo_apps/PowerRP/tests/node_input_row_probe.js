/**
 * NODE INPUT ROW probe — THE WIRE AND THE INSPECTOR MUST AGREE, on the real editor.
 *
 * ── THE SCREENSHOT THIS EXISTS FOR ──────────────────────────────────────────
 * USER, 2026-08-03 (verbatim): "It says level has no input and yet I see it"
 * — a Level node (audio_meter) with green wires visibly attached at both beads,
 * whose Inspector INPUTS row simultaneously read "— not connected —".
 *
 * It looked like two stores disagreeing. It was not: there has only ever been ONE
 * connection leaf, `inputs.<port>` (core/nodeflow.js states the shape, and
 * connectionsOf is its only reader). The Inspector's option list simply asked the
 * WRONG OBJECT for the document — `state.items` inside the row snippet, where
 * `state` is the SELECTED ITEM'S own folded state and has no `.items` at all. So
 * compatibleSources searched an empty document, produced no options, and the
 * dropdown fell back to its "not connected" entry while the stored reference sat
 * intact and the wire drew from it normally.
 *
 * ── WHY A BROWSER PROBE AND NOT A UNIT TEST ─────────────────────────────────
 * The defect lived in the gap BETWEEN a pure function that was always right and a
 * component that called it with the wrong argument. Every bare-node test of
 * compatibleSources passed throughout, because they all passed it a real item map.
 * Only the rendered panel could show the disagreement, so only the rendered panel
 * can pin it shut.
 *
 * ── THIS PROBE DID NOT BITE, AND WHY (WORKSTREAM CH, 2026-08-03) ────────────
 * As first committed it read the row's FIRST <button>. An Inspector row's first
 * button is the copy-path icon — an <iconify-icon> whose textContent is "" — so
 * every text assertion below ran against "" and passed BYTE-IDENTICALLY on fixed
 * and broken code. It asserted nothing at all. (`shown.length > 0` was the one
 * assertion that could have caught it, and it is the one that failed; the three
 * around it were vacuous.) It is now anchored on `.dd-trigger`, THE control, and
 * the selector is deliberately EXACT — no `button,` alternative to fall back to,
 * because a fallback is what made a wrong element look like a right answer.
 * Commit dd6a3e6 also shipped it knowingly red ("cannot run green in this tree
 * right now"), which is the practice that let an app-wide dead Inspector hide for
 * hours. It runs green at its fix now, in the same commit.
 *
 * WHAT IS ASSERTED, and the two halves are deliberately opposite:
 *   1. WIRED: the dropdown NAMES the source, the stored leaf holds it, and
 *      deriveWires draws exactly one wire — three surfaces, one answer.
 *   2. UNWIRED: it honestly reads "not connected", the leaf is null, and NO wire
 *      is drawn. (Without this half the fix could be "always show something".)
 *   3. The option list is non-empty and OFFERS the compatible source — the exact
 *      thing that was empty, asserted directly rather than through its symptom.
 *   4. THE LAW, stated as one sentence the probe can check: a CONNECTED input's
 *      row never renders placeholder text, and DOES render the source's name. The
 *      placeholder is identified STRUCTURALLY (Dropdown's own `.dd-placeholder`
 *      class, which it puts on the label exactly when no item resolved) as well as
 *      by its text, because the second remnant of this bug showed the generic
 *      "Select…" rather than "— not connected —" and a text-only check for the
 *      latter read a broken panel as fixed.
 *
 * Frontend-only Vite on an EPHEMERAL port, per the probe convention.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/node_input_row_probe.js
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

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  // ── THE PATCH: an oscillator into a Level meter, exactly the screenshot ─────
  const ids = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    const add = (type, over) => {
      app.addItem({ ...app.registry.get(type).defaults, type, ...over });
      return app.selection;
    };
    const osc = add("audio_oscillator", { x: 120, y: 200 });
    // The meter is titled "Level" on its card — the node in the screenshot.
    const meter = add("audio_meter", { x: 460, y: 200, inputs: { in: { item: osc, port: "out" } } });
    app.selection = meter;
    return { osc, meter };
  });
  await sleep(900);

  const expand = async () => {
    await page.evaluate(() => {
      for (const h of document.querySelectorAll(".inspector .cat-header"))
        if (h.getAttribute("aria-expanded") === "false") h.click();
    });
    await sleep(400);
  };
  await expand();

  /** Reads all three surfaces at once: what the panel SAYS, what the document
   *  STORES, and how many wires the render tree DRAWS. The point of the probe is
   *  that these cannot disagree, so they are read together. */
  const surfaces = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const rows = [...document.querySelectorAll(".inspector .row")];
    const inputRow = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "in");
    // EXACTLY `.dd-trigger` — see the header. The row's first <button> is a
    // copy-path icon with empty text, and accepting it is what made this probe blind.
    const trigger = inputRow?.querySelector(".dd-trigger");
    const label = trigger?.querySelector(".dd-trigger-label");
    return {
      rowPresent: !!inputRow,
      triggerPresent: !!trigger,
      shown: (label ?? trigger)?.textContent.trim() ?? "",
      // Dropdown's OWN structural signal that nothing resolved for `value`.
      placeholderStyled: !!label?.classList.contains("dd-placeholder"),
      stored: app.rawState().items?.[app.selection]?.inputs?.in ?? null,
    };
  });

  // ── 1. WIRED: all three surfaces name the same connection ──────────────────
  // THE LAW: a connected input's row never renders placeholder text and DOES
  // render the source's name. Both spellings of "placeholder" are refused — the
  // node-input row's own "— not connected —" AND Dropdown's generic "Select…",
  // which is what a failed value→item resolution actually shows.
  const wired = await surfaces();
  assert(wired.rowPresent, "the Level node's INPUTS section renders an `in` row");
  assert(wired.triggerPresent, "and that row's control is a .dd-trigger (NOT the copy-path icon)");
  assert(wired.stored && wired.stored.item === ids.osc,
    `the document STORES the connection (${JSON.stringify(wired.stored)})`);
  assert(!/not connected/i.test(wired.shown),
    `and the dropdown does NOT claim "not connected" — it reads ${JSON.stringify(wired.shown)}`);
  assert(!/^select…?$/i.test(wired.shown),
    `nor Dropdown's generic placeholder, which is what an unresolved value shows (${JSON.stringify(wired.shown)})`);
  assert(!wired.placeholderStyled,
    "nor is the label styled .dd-placeholder — Dropdown resolved the bound value to a real option");
  assert(wired.shown.length > 0, "the dropdown NAMES the source rather than showing an empty label");
  assert(wired.shown.includes("oscillator"),
    `and the name it renders is the SOURCE's (${JSON.stringify(wired.shown)})`);

  // ── 3. THE OPTION LIST, asserted directly ──────────────────────────────────
  // This is the value that was empty. Reading it through the core function with
  // the SAME argument the component now passes is the regression's tightest pin.
  // `/@fs<abs>` is how a probe reaches core/ from the web/ vite root (the
  // clipboard_duplicate_probe precedent). "/../core/…" does NOT resolve — it 404s
  // and the probe dies on an unhandled rejection before reaching its later halves,
  // which is the second reason this file could not run green.
  await page.evaluate((root) => { window.__powerrp_probeRoot = root; }, resolve(HERE, ".."));
  const options = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { compatibleSources } = await import("/@fs" + window.__powerrp_probeRoot + "/core/nodeflow.js");
    const items = app.state().items ?? {};
    return compatibleSources(items, app.registry, { item: app.selection, port: "in" })
      .map((o) => `${o.item}.${o.port}`);
  });
  assert(options.length > 0, `compatibleSources offers ${options.length} source(s) for the meter's audio in`);
  assert(options.some((o) => o.startsWith(ids.osc)),
    `and the oscillator is among them: ${JSON.stringify(options)}`);

  // ── 2. UNWIRED: the honest opposite ────────────────────────────────────────
  // DRIVEN THROUGH `disconnectPairs`, NOT A HAND-SPELLED PATH. This probe used to
  // write [["items", id, "inputs.in"], null] — three segments with a DOTTED key —
  // and that is not the same write the app makes. `deltas.setPath` treats each
  // array element as ONE key, so the dotted form creates a literal `"inputs.in"`
  // property beside the real `inputs` tree and leaves the connection standing:
  //   setPath({}, ["items","abc","inputs.in"], null) -> {items:{abc:{"inputs.in":null}}}
  //   setPath({}, ["items","abc","inputs","in"], null) -> {items:{abc:{inputs:{in:null}}}}
  // The app never produces the first shape (the Inspector commits through
  // `oncommit(row.key, …)` -> app.svelte.js:4231 `key.split(".")`, which splits it),
  // so those three reds were the PROBE being wrong about the app, not the app being
  // broken — the exact failure mode a probe exists to avoid. Calling the core
  // function the UI calls means this can never drift from the real write again.
  await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { disconnectPairs } = await import("/@fs" + window.__powerrp_probeRoot + "/core/nodeflow.js");
    app.setPreview(disconnectPairs({ item: app.selection, port: "in" }));
    app.commitPreview();
  });
  await sleep(700);
  const cut = await surfaces();
  // WHAT "DISCONNECTED" IS IN THE STORE: `disconnectPairs` writes deltas.NONE,
  // and NONE is the delete sentinel (core/deltas.js:23), so the folded leaf is
  // ABSENT, not literally null. Both spellings read as unwired at the one reader
  // that matters — connectionsOf skips on `!c` (nodeflow.js:560) — so the law to
  // pin is "nothing that names a source", not a particular falsy encoding. The
  // old assertion demanded `=== null` exactly and would have gone red on a
  // correct disconnect; asserting the encoding rather than the meaning is how a
  // test starts dictating an implementation detail it was never asked to guard.
  assert(cut.stored == null, `disconnecting leaves no source reference (${JSON.stringify(cut.stored)})`);
  assert(/not connected/i.test(cut.shown),
    `and NOW the dropdown honestly reads "not connected" (${JSON.stringify(cut.shown)})`);
  // The unwired state is a RESOLVED option ("" → the "— not connected —" row), NOT
  // an unresolved value. So even here the label must not be .dd-placeholder — which
  // is what distinguishes "honestly disconnected" from "failed to resolve".
  assert(!cut.placeholderStyled,
    "and it says so by SELECTING the disconnect option, not by failing to resolve");

  // ── The wire follows the property, in both directions ──────────────────────
  const wires = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const { deriveRenderTree, deriveWires } = await import("/@fs" + window.__powerrp_probeRoot + "/core/derive.js");
    const { connectPairs } = await import("/@fs" + window.__powerrp_probeRoot + "/core/nodeflow.js");
    const count = () => deriveWires(deriveRenderTree(app.state(), app.registry)).length;
    const cut = count();
    // Through `connectPairs` for the same reason the cut goes through
    // `disconnectPairs` — see above. The dotted path this used to spell wrote a
    // key no reader looks at, so "reconnecting draws one wire" was being asked of
    // a document that had never been rewired.
    const osc = Object.keys(app.rawState().items ?? {}).find((k) => app.rawState().items[k].type === "audio_oscillator");
    app.setPreview(connectPairs({ item: osc, port: "out" }, { item: app.selection, port: "in" }));
    app.commitPreview();
    await new Promise((r) => setTimeout(r, 300));
    return { cut, rewired: count() };
  });
  assert(wires.cut === 0, `no wire is drawn while the input is null (${wires.cut})`);
  assert(wires.rewired === 1, `and reconnecting draws exactly one again (${wires.rewired})`);
} finally {
  await browser.close();
  await server.close();
}

console.log(fails.length === 0
  ? "\nnode input row: the wire and the Inspector agree, both wired and cut"
  : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
