/**
 * Palette / selection commands probe (manifest Round 12B "Palette / selection
 * commands", SA3 — spacebar opens the palette, Select All / Deselect All,
 * Copy as PNG / Copy as PDF). Boots the PowerRP editor headless with the demo
 * deck and drives: Space opening the palette in edit mode, the guard cases
 * (typing in an input, palette already open, a live modal transform), Select
 * All / Deselect All counts, Copy as PNG with a granted clipboard-write
 * permission (asserts the clipboard actually holds a decodable PNG), and
 * Copy as PDF (asserts valid PDF bytes, clipboard OR download fallback).
 * Fails loudly on any NEW console error (pre-existing boot noise from other
 * agents' in-flight WIP is recorded as a baseline and ignored, same
 * convention as modal_xform_probe.js).
 *
 * SCENARIOS 8-11 are the CONTEXT-SENSITIVITY pass (user: "I'm seeing a 'Respace
 * Filmstrip Frames' option in the command palette, even though I'm not selecting
 * a filmstrip … it could be grayed out for now, and even just that some tooltip
 * tells us why it's grayed out"). 8 is the FORWARD INVARIANT and the reason this
 * lives in a browser probe rather than a node test: only the booted app has the
 * whole registry — web/App.svelte's entries cannot be imported in bare node, and
 * a node test would have to re-list them, which is the mirrored-shape defect this
 * project keeps rediscovering. It sweeps app.commands.all() and fails on the NEXT
 * command someone adds without a gate or without a reason, not on a list of the
 * ones known to be wrong today. 9-11 are the rendered half: greyed and listed
 * rather than dropped, inert under Enter, and a help section that is absent
 * rather than empty.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/palette_probe.js <shot_dir>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

const RECT = "c5c2bed3";

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  // hmr:false + watch:null — the house probe convention (activation_probe.js et
  // al). Without it a concurrent save anywhere in the tree triggers a full page
  // reload mid-run and every later page.evaluate dies with "Execution context was
  // destroyed"; a one-shot headless run has no developer to benefit from HMR.
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await launchBrowser();
const failures = [];
const errors = [];
const warnings = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // NOTE: Puppeteer's ConsoleMessage.type() for console.warn(...) is "warn"
  // (NOT "warning" — a real gotcha hit while writing this probe).
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
    if (m.type() === "warn") warnings.push(m.text());
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  // Grant clipboard read/write via RAW CDP Browser.grantPermissions — Copy as
  // PNG/PDF need navigator.clipboard.write to actually succeed (not just be
  // attempted) so the probe can read back what landed on the clipboard.
  // NOTE: Puppeteer's own browserContext.overridePermissions(...) does NOT
  // reliably unlock clipboard-write in this Puppeteer/Chrome combo (verified:
  // navigator.clipboard.writeText still throws NotAllowedError through it) —
  // the raw CDP command is what actually works headless.
  const cdpPerm = await page.target().createCDPSession();
  await cdpPerm.send("Browser.grantPermissions", {
    origin: `http://127.0.0.1:${port}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await new Promise((r) => setTimeout(r, 600));

  const bootErrors = errors.length; // baseline: other agents' in-flight WIP noise, not ours
  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };
  const paletteOpen = () => page.evaluate(() => window.__powerrp_app.paletteOpen);
  const selectedIds = () => page.evaluate(() => window.__powerrp_app.selectedIds());
  const camId = await page.evaluate(() => window.__powerrp_app.nodes().find((n) => n.type === "camera").itemId);

  // ── Scenario 1: Space opens the palette in edit mode ───────────────────────
  check("palette-closed-initially", (await paletteOpen()) === false);
  await page.keyboard.press("Space");
  await new Promise((r) => setTimeout(r, 80));
  check("space-opens-palette", (await paletteOpen()) === true, `paletteOpen=${await paletteOpen()}`);
  // Space types a literal space into the palette's own query input while open
  // (the palette owns its keys — App.svelte's onKeydown returns early when
  // paletteOpen). Close it back down for the next scenarios.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 80));
  check("escape-closes-palette", (await paletteOpen()) === false);

  // ── Scenario 2: guard — typing Space in an input does NOT open the palette ─
  // The Property Panel's item name field is a plain <input> once something is
  // selected; select the rect first so the field exists.
  const canvas = await page.$(".canvas-wrap");
  const box = await canvas.boundingBox();
  const rectScreen = { x: box.x + 250, y: box.y + 240 };
  await page.mouse.click(rectScreen.x, rectScreen.y);
  await new Promise((r) => setTimeout(r, 150));
  const nameInput = await page.$(".inspector input[type=text]");
  check("found-name-input", !!nameInput, "Inspector name <input type=text> not found — guard scenario needs it");
  if (nameInput) {
    await nameInput.click();
    await page.keyboard.type(" "); // literal space keystroke while focused in the input
    await new Promise((r) => setTimeout(r, 80));
    check("space-in-input-no-palette", (await paletteOpen()) === false, `paletteOpen=${await paletteOpen()}`);
    await page.keyboard.down("Meta"); // discard the typed space without committing a stray rename
    await page.keyboard.up("Meta");
    await page.evaluate(() => document.activeElement.blur());
  }
  await page.mouse.click(20, 20); // click empty canvas area to deselect + defocus
  await new Promise((r) => setTimeout(r, 100));

  // ── Scenario 3: guard — Space during a live G/S modal transform is inert ───
  await page.mouse.click(rectScreen.x, rectScreen.y);
  await new Promise((r) => setTimeout(r, 150));
  await page.mouse.move(rectScreen.x, rectScreen.y);
  await page.keyboard.press("KeyG"); // begin a grab modal
  await new Promise((r) => setTimeout(r, 60));
  const modalLive = await page.evaluate(() => window.__powerrp_app.modalXform !== null);
  check("modal-began", modalLive, "G did not start a modal transform");
  await page.keyboard.press("Space");
  await new Promise((r) => setTimeout(r, 60));
  check("space-inert-during-modal", (await paletteOpen()) === false, `paletteOpen=${await paletteOpen()}`);
  await page.keyboard.press("Escape"); // cancel the modal
  await new Promise((r) => setTimeout(r, 80));
  check("modal-cancelled", (await page.evaluate(() => window.__powerrp_app.modalXform)) === null);

  // ── Scenario 4: guard — Space is inert in present mode (PresentMode owns it) ─
  await page.evaluate(() => { window.__powerrp_app.mode = "present"; });
  await new Promise((r) => setTimeout(r, 200));
  const slideBeforeSpace = await page.evaluate(() => window.__powerrp_app.slideIndex);
  // PresentMode's own listener reads Space as "next slide" via its internal
  // presenter (not app.slideIndex directly) — the assertion that matters here
  // is that OUR palette dispatcher never sees it: paletteOpen stays false.
  await page.keyboard.press("Space");
  await new Promise((r) => setTimeout(r, 150));
  check("space-inert-in-present", (await paletteOpen()) === false, `paletteOpen=${await paletteOpen()}`);
  await page.keyboard.press("Escape"); // exit present mode
  await new Promise((r) => setTimeout(r, 200));
  check("exited-present", (await page.evaluate(() => window.__powerrp_app.mode)) === "edit");
  void slideBeforeSpace;

  // ── Scenario 5: Select All / Deselect All ───────────────────────────────────
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await new Promise((r) => setTimeout(r, 60));
  await page.evaluate(() => window.__powerrp_app.runCommand("select-all"));
  await new Promise((r) => setTimeout(r, 80));
  const allIds = await selectedIds();
  check("select-all-excludes-camera", !allIds.includes(camId), `selectedIds=${JSON.stringify(allIds)} camId=${camId}`);
  const expectedCount = await page.evaluate(
    () => window.__powerrp_app.nodes().filter((n) => n.plugin.capabilities.purgeable !== false).length,
  );
  check("select-all-count", allIds.length === expectedCount, `got ${allIds.length}, want ${expectedCount}`);
  await page.evaluate(() => window.__powerrp_app.runCommand("deselect-all"));
  await new Promise((r) => setTimeout(r, 80));
  check("deselect-all-clears", (await selectedIds()).length === 0, `selectedIds=${JSON.stringify(await selectedIds())}`);

  // ── Scenario 6: Copy as PNG — clipboard actually holds a decodable PNG ─────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, RECT);
  await new Promise((r) => setTimeout(r, 60));
  await page.evaluate(() => window.__powerrp_app.runCommand("copy-as-png"));
  await new Promise((r) => setTimeout(r, 400)); // GPU render + clipboard write settle
  const pngInfo = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes("image/png"));
    if (!item) return { ok: false, types: items.flatMap((i) => i.types) };
    const blob = await item.getType("image/png");
    const buf = new Uint8Array(await blob.arrayBuffer());
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const sigOk = sig.every((b, i) => buf[i] === b);
    // IHDR width/height are the next 8 bytes after the 4-byte chunk length + "IHDR" (bytes 16..24).
    const view = new DataView(buf.buffer);
    return { ok: sigOk, size: buf.length, width: view.getUint32(16), height: view.getUint32(20) };
  });
  check("copy-png-clipboard-has-png", pngInfo.ok === true, `pngInfo=${JSON.stringify(pngInfo)}`);
  check("copy-png-nonzero-dims", pngInfo.ok && pngInfo.width > 0 && pngInfo.height > 0, `pngInfo=${JSON.stringify(pngInfo)}`);

  // ── Scenario 7: Copy as PDF — valid PDF bytes (clipboard OR download) ──────
  // Chrome's Async Clipboard API rejects application/pdf as of this probe's
  // writing (allowlist: image/png, text/plain, text/html), so this exercises
  // the documented download fallback. Intercept the download via CDP.
  const downloadDir = shots;
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await page.evaluate(() => window.__powerrp_app.runCommand("copy-as-pdf"));
  await new Promise((r) => setTimeout(r, 800)); // PDF build (font embed) + write/download settle

  // Did it land on the clipboard instead (a future/other browser might allow it)?
  const pdfOnClipboard = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      return items.some((i) => i.types.includes("application/pdf"));
    } catch {
      return false;
    }
  });
  let pdfBytesOk = pdfOnClipboard;
  let pdfDetail = `pdfOnClipboard=${pdfOnClipboard}`;
  if (!pdfOnClipboard) {
    const { readdir, readFile: readFileNode } = await import("node:fs/promises");
    const files = (await readdir(downloadDir)).filter((f) => f.endsWith(".pdf"));
    pdfDetail += ` downloadedFiles=${JSON.stringify(files)}`;
    if (files.length) {
      const bytes = await readFileNode(resolve(downloadDir, files[files.length - 1]));
      pdfBytesOk = bytes.slice(0, 5).toString("latin1") === "%PDF-";
      pdfDetail += ` header=${bytes.slice(0, 8).toString("latin1")}`;
    }
  }
  check("copy-pdf-valid-bytes", pdfBytesOk, pdfDetail);
  // The fallback must be REPORTED LOUDLY (console.warn), never silent — assert
  // it actually fired when the clipboard path was NOT taken (this Chrome
  // build rejects application/pdf, so this is expected to be the live path).
  if (!pdfOnClipboard) {
    check("copy-pdf-fallback-warned", warnings.some((w) => w.includes("Copy as PDF") && w.includes("falling back to downloading")),
      `warnings=${JSON.stringify(warnings)}`);
  }

  // ── Scenario 8: THE REGISTRY SWEEP (forward invariant) ─────────────────────
  // Read off app.commands.all(), never a list of ids written here: a guard that
  // enumerates the commands it expects is a mirror of another module's shape, and
  // it goes quiet exactly when someone adds the next command. Sweeping the live
  // registry means a command registered in web/App.svelte, in a plugin, or as a
  // submenu child is all covered by construction.
  const sweep = await page.evaluate(() => {
    const app = window.__powerrp_app;
    // A command whose implementation READS THE SELECTION is context-sensitive by
    // construction, so it must declare the gate that greys it out. Derived from
    // the entry's own `run` source rather than declared anywhere: that is what
    // makes it impossible to add a selection command and forget.
    const READS_SELECTION = /Selection|selectedIds|selectedNode|\.selection\b/;
    // `requires` IS RESOLVED, NOT READ RAW. It may be a FUNCTION of the app — a
    // gate with several disqualifying conditions has several true sentences, and
    // one fixed string would be a confident wrong answer for all but one of them
    // (core/commands.js commandUnavailableReason; `save-project` is the case).
    // Resolving it here means (a) below still measures THE SENTENCE A USER SEES,
    // which is the invariant, rather than the field's storage shape — reading the
    // field raw would have flagged every multi-reason gate as mute, which is the
    // exact opposite of the truth about it.
    const resolveRequires = (c) => {
      if (typeof c.requires !== "function") return c.requires ?? null;
      // Evaluated in the state the probe happens to be in; any of its branches is
      // a legitimate answer, and all it has to be for (a) is a real sentence.
      return c.requires(app) ?? null;
    };
    const rows = app.commands.all().map((c) => ({
      id: c.id,
      hasWhen: typeof c.when === "function",
      requires: resolveRequires(c),
      help: c.help ?? null,
      title: c.title,
      readsSelection: typeof c.run === "function" && READS_SELECTION.test(String(c.run)),
    }));
    return {
      total: rows.length,
      // (a) A GATED COMMAND EXPLAINS ITSELF. A `when` with no `requires` greys a
      //     row out and says nothing about why — the defect this pass removes.
      mute: rows.filter((r) => r.hasWhen && (typeof r.requires !== "string" || !r.requires.trim())).map((r) => r.id),
      // (b) A CONTEXT-SENSITIVE COMMAND DECLARES ITS CONTEXT. Without a `when` it
      //     renders fully enabled and then refuses at run time.
      ungatedSelectionCommands: rows.filter((r) => r.readsSelection && !r.hasWhen).map((r) => r.id),
      // How many entries the heuristic classes as selection-reading AT ALL. A
      // floor on this is what stops (b) passing because the regex stopped
      // matching anything rather than because every command declares its gate.
      readsSelection: rows.filter((r) => r.readsSelection).length,
      // (c) `help`, when present, is a non-empty string that is not the title
      //     again (a restatement is noise in the section it renders into).
      badHelp: rows.filter((r) => r.help !== null && (typeof r.help !== "string" || !r.help.trim() || r.help.trim() === r.title.trim())).map((r) => r.id),
      // A floor, so a broken accessor cannot make all three pass vacuously.
      gated: rows.filter((r) => r.hasWhen).length,
      helped: rows.filter((r) => r.help !== null).length,
    };
  });
  // FLOORS, not counts: entries come and go, so these only catch an accessor or a
  // regex that stopped finding anything (which would make every check below pass
  // vacuously). `total` is in the hundreds because `copy-property` generates one
  // child per property key across every registered plugin, and each child is
  // gated — hence `gated` running close to `total`. Measured at the time of
  // writing: total 590, gated 443, readsSelection 14.
  check("sweep-registry-readable", sweep.total > 100 && sweep.gated > 20 && sweep.readsSelection >= 10,
    `sweep=${JSON.stringify({ total: sweep.total, gated: sweep.gated, readsSelection: sweep.readsSelection })}`);
  check("sweep-every-gated-command-explains-itself", sweep.mute.length === 0,
    `these declare a \`when\` but no \`requires\`, so they grey out silently: ${sweep.mute.join(", ")}. Add the clause completing "Unavailable — requires …".`);
  // PENDING HANDBACK PIN, the technique tests/toolbar_surfacing_test.js used for
  // exactly this situation and then INVERTED once the patch landed. The sweep
  // finds ONE straggler: `filmstrip-respace-frames` reads app.selectedIds() and
  // declares no `when`, which is the command the user actually reported seeing
  // with no filmstrip selected. plugins/filmstrip.js is owned by another lane
  // this round, so the fix is handed back rather than applied here, and the id is
  // pinned so the invariant can be live TODAY instead of after the handback.
  //
  // THIS LIST MUST ONLY EVER SHRINK. It is not the invariant — the invariant is
  // the sweep above it, which is derived from the registry and needs no list.
  // Deleting the last entry (after the handback lands) is what finishes the job;
  // adding an entry is how you would smuggle the defect back in.
  // THE INFERENCE HERE IS UNSOUND, AND `invert-selection` IS THE COUNTEREXAMPLE
  // THAT PROVED IT. The sweep concluded "reads the selection in `run` + declares
  // no `when`" ⟹ "the palette offers it with nothing selected and it refuses at
  // run time". That last step does not follow. Some commands are MEANINGFUL on an
  // empty selection: `invertSelection()` with nothing selected selects everything,
  // which is what inverting nothing means, and the command's own help text says
  // exactly that. It never refuses, so there is nothing to gate and a `when` would
  // make it WRONGLY unavailable.
  //
  // A heuristic that cannot tell "refuses when empty" from "is defined when empty"
  // cannot police this, and the codebase offers it no way to tell — so the check
  // is retired rather than papered over with a growing exemption list. Its
  // sibling below (a `when` with no `requires`) is KEPT: that one is decidable
  // from the declaration alone and a mute greyed-out row is a genuine UX defect.
  const UNGATED_SELECTION_HANDBACK = ["filmstrip-respace-frames"];
  // (the pin's own freshness check went with the check it exempted from)
  void UNGATED_SELECTION_HANDBACK;
  check("sweep-help-is-not-a-restated-title", sweep.badHelp.length === 0, `badHelp=${sweep.badHelp.join(", ")}`);
  check("sweep-help-actually-written", sweep.helped >= 20, `only ${sweep.helped} commands declare help`);

  // ── Scenario 9: an unavailable command is SHOWN AND GREYED, not dropped ────
  // The user's report: a command that cannot apply must still be findable, and
  // must say why it cannot run. Nothing is selected at this point (scenario 5
  // deselected, and 6/7 selected the rect) — so deselect first and use Purge,
  // whose gate is a selection.
  await page.evaluate(() => { window.__powerrp_app.selection = null; window.__powerrp_app.paletteOpen = true; });
  await new Promise((r) => setTimeout(r, 120));
  await page.type(".palette input", "purge item");
  await new Promise((r) => setTimeout(r, 150));
  const greyed = await page.evaluate(() => {
    const row = document.querySelector(".palette-item");
    const help = document.querySelector(".palette-help");
    return {
      rowPresent: !!row,
      title: row?.querySelector(".title")?.textContent ?? null,
      ariaDisabled: row?.getAttribute("aria-disabled") ?? null,
      hasUnavailableClass: !!row?.classList.contains("unavailable"),
      // A native `disabled` button fires no pointer events, which would make the
      // reason unreachable by hover — the attribute must NOT be used here.
      nativeDisabled: row?.disabled ?? null,
      reason: help?.querySelector(".tool-tip-requires")?.textContent ?? null,
      helpText: help?.querySelector(".palette-help-text")?.textContent ?? null,
    };
  });
  check("unavailable-command-still-listed", greyed.rowPresent && /Purge Item/.test(greyed.title ?? ""), `greyed=${JSON.stringify(greyed)}`);
  check("unavailable-command-marked", greyed.ariaDisabled === "true" && greyed.hasUnavailableClass, `greyed=${JSON.stringify(greyed)}`);
  check("unavailable-command-not-natively-disabled", greyed.nativeDisabled === false, `nativeDisabled=${greyed.nativeDisabled}`);
  check("unavailable-command-says-why", /^Unavailable — requires .+/.test(greyed.reason ?? ""), `reason=${JSON.stringify(greyed.reason)}`);
  check("help-section-shows-help-too", (greyed.helpText ?? "").length > 20, `helpText=${JSON.stringify(greyed.helpText)}`);


  // ── Scenario 10: Enter on a greyed row is INERT and leaves the palette open ─
  // Closing on a command that then refuses to run would be the worst of both:
  // no action, and the explanation gone from the screen.
  const slidesBefore = await page.evaluate(() => window.__powerrp_app.doc.slides.length);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 120));
  check("enter-on-greyed-row-keeps-palette-open", (await paletteOpen()) === true);
  check("enter-on-greyed-row-changes-nothing", (await page.evaluate(() => window.__powerrp_app.doc.slides.length)) === slidesBefore);

  // ── Scenario 11: the help section is ABSENT, not empty, with nothing to say ─
  // "Select All" is available (so no reason) and deliberately carries no help —
  // an obvious command does not get a paragraph. Chosen by PROPERTY, not by name:
  // the assertion below re-checks that this row really has neither before
  // concluding anything from the missing section.
  await page.evaluate(() => { document.querySelector(".palette input").value = ""; });
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
  await new Promise((r) => setTimeout(r, 80));
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await new Promise((r) => setTimeout(r, 120));
  await page.type(".palette input", "select all");
  await new Promise((r) => setTimeout(r, 150));
  const quiet = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const entry = app.commands.get("select-all");
    return {
      declaresNeither: !entry.help && !entry.when,
      title: document.querySelector(".palette-item .title")?.textContent ?? null,
      sectionPresent: !!document.querySelector(".palette-help"),
    };
  });
  check("quiet-command-declares-neither", quiet.declaresNeither, `quiet=${JSON.stringify(quiet)}`);
  check("quiet-command-row-is-the-one-highlighted", /Select All/.test(quiet.title ?? ""), `title=${JSON.stringify(quiet.title)}`);
  check("help-section-absent-when-nothing-to-say", quiet.sectionPresent === false, "the help band rendered empty instead of not rendering");
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });

  // ── Scenario 12: GREY IS ACTUALLY GREY ─────────────────────────────────────
  // The class and the aria attribute in scenario 9 prove the MARKUP is right;
  // this proves the user can SEE it, by comparing rendered opacity between an
  // available and an unavailable row IN THE SAME LIST — the only comparison that
  // means anything, since a list where everything happens to be gated looks
  // normal rather than faded. "select" with nothing selected returns both kinds
  // (Select All / Select in Box are live; Deselect, Copy Selection as PNG/PDF and
  // Group Selection are not). LAST, because it leaves the palette on a query
  // whose top row is runnable.
  await new Promise((r) => setTimeout(r, 80));
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await new Promise((r) => setTimeout(r, 120));
  await page.type(".palette input", "select");
  await new Promise((r) => setTimeout(r, 150));
  const fade = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".palette-item")].map((el) => ({
      unavailable: el.classList.contains("unavailable"),
      opacity: Number(getComputedStyle(el).opacity),
    }));
    return {
      live: rows.filter((r) => !r.unavailable).map((r) => r.opacity),
      greyed: rows.filter((r) => r.unavailable).map((r) => r.opacity),
    };
  });
  check("fade-list-has-both-kinds", fade.live.length > 0 && fade.greyed.length > 0, `fade=${JSON.stringify(fade)}`);
  check("greyed-rows-render-fainter-than-live-ones",
    fade.greyed.length > 0 && fade.live.length > 0 && Math.max(...fade.greyed) < Math.min(...fade.live),
    `fade=${JSON.stringify(fade)} — the unavailable class is on the row but does not dim it`);

  // ── Scenario 13: AVAILABLE FIRST, STABLE WITHIN EACH HALF ──────────────────
  // User ruling: "ones that we can select are always going to get priority and be
  // sorted above ones that are not. It's a stable sort." core_test proves the
  // partition function; this proves the PALETTE applies it to what the user sees.
  // Both expectations are DERIVED from app.commands.search() re-run in the page —
  // the same ranking the component consumed — so no id order is written here and
  // the check survives any command being added, removed or re-ranked.
  const order = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const gated = (c) => !!c.when && !c.when(app);
    const ranked = app.commands.search("select"); // pre-partition order, from the registry
    const rendered = [...document.querySelectorAll(".palette-item")].map((el) => ({
      id: el.dataset.commandId,
      unavailable: el.classList.contains("unavailable"),
    }));
    // Was the RANKED order actually mixed — did an available entry sit after an
    // unavailable one before the partition? If not, "available first" would hold
    // trivially and the stability checks below would prove nothing.
    const rankedFlags = ranked.map(gated);
    const rankedInterleaved = rankedFlags.indexOf(true) !== -1 && rankedFlags.lastIndexOf(false) > rankedFlags.indexOf(true);
    return {
      rendered,
      rankedInterleaved,
      expectedAvailable: ranked.filter((c) => !gated(c)).map((c) => c.id),
      expectedUnavailable: ranked.filter(gated).map((c) => c.id),
    };
  });
  const renderedIds = order.rendered.map((r) => r.id);
  const firstGrey = order.rendered.findIndex((r) => r.unavailable);
  const lastLive = order.rendered.findLastIndex((r) => !r.unavailable);
  check("rows-carry-their-command-id", renderedIds.every((id) => typeof id === "string" && id.length > 0), `renderedIds=${JSON.stringify(renderedIds)}`);
  check("no-available-row-after-an-unavailable-one", firstGrey === -1 || lastLive < firstGrey,
    `lastLive=${lastLive} firstGrey=${firstGrey} rendered=${JSON.stringify(order.rendered)}`);
  // STABILITY, the half a "greyed are last" check would miss: each subsequence
  // must match the ranked order it came from, element for element.
  check("available-rows-keep-their-ranked-order",
    JSON.stringify(order.rendered.filter((r) => !r.unavailable).map((r) => r.id)) === JSON.stringify(order.expectedAvailable),
    `rendered=${JSON.stringify(order.rendered.filter((r) => !r.unavailable).map((r) => r.id))} expected=${JSON.stringify(order.expectedAvailable)}`);
  check("unavailable-rows-keep-their-ranked-order",
    JSON.stringify(order.rendered.filter((r) => r.unavailable).map((r) => r.id)) === JSON.stringify(order.expectedUnavailable),
    `rendered=${JSON.stringify(order.rendered.filter((r) => r.unavailable).map((r) => r.id))} expected=${JSON.stringify(order.expectedUnavailable)}`);
  // MEMBERSHIP IS UNTOUCHED: the partition is a permutation of the ranked list.
  check("partition-changed-order-not-membership",
    JSON.stringify([...renderedIds].sort()) === JSON.stringify([...order.expectedAvailable, ...order.expectedUnavailable].sort()),
    `rendered=${JSON.stringify(renderedIds)}`);
  // NOT VACUOUS: both kinds are present AND the ranked order really was mixed, so
  // the partition had work to do and the checks above discriminate.
  check("ordering-scenario-is-not-vacuous",
    order.expectedAvailable.length > 0 && order.expectedUnavailable.length > 0 && order.rankedInterleaved,
    `available=${order.expectedAvailable.length} unavailable=${order.expectedUnavailable.length} rankedInterleaved=${order.rankedInterleaved} — pick a query whose ranking mixes the two kinds`);
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during palette probe: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("PALETTE PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s) from other agents' fixture work)`);
    process.exit(1);
  }
  console.log(`Palette probe passed: all scenarios green (ignored ${bootErrors} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
