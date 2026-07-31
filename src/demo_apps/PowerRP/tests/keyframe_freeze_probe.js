/**
 * KEYFRAME TOOLS probe — the BROWSER half of tests/keyframe_freeze_test.js, for
 * the pair "Make Static from Current Slide" / "Remove Keyframes on This Slide".
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/keyframe_freeze_probe.js <shot_dir>
 *
 * WHY A BROWSER PROBE. Four of the claims cannot be made in bare node:
 *   - ONE UNDO PUTS IT BACK. The undo log lives on the app (web/app.svelte.js),
 *     and the proof has to be a WHOLE-DOCUMENT comparison through a fresh proxy —
 *     reference identity would pass for free and prove nothing.
 *   - THE PIXELS DO NOT MOVE where Make Static was run. The manifest's core
 *     invariant is RenderTree = pure(document, [[slide, alpha]]), so the honest
 *     check is the DERIVED TREE, and the belt-and-braces one is real PNG bytes
 *     off the GPU path (Copy Selection as PNG).
 *   - THE OTHER TOOL DOES CHANGE WHAT YOU SEE, and that asymmetry is the point of
 *     the split: clearing a slide's entry makes the item INHERIT the previous
 *     slide, so the render on that slide becomes the previous slide's.
 *   - THE SURFACINGS AGREE. Only the booted app holds the whole command registry
 *     and the resolved tool groups; a node test would have to re-list them, which
 *     is the mirrored-shape defect this project keeps rediscovering.
 *
 * THE TWO SEMANTIC CLAIMS IT PINS DOWN AT THE UI LEVEL:
 *   KEYFRAMED VISIBILITY IS NOT ANIMATION — the demo deck's title text carries
 *     exactly one later keyframe, an `active: false` on slide 3, and it falls
 *     OUTSIDE the visible run containing slide 1, so Make Static must be GREYED
 *     there and say why. If that flips to enabled, the tool has started silently
 *     undoing people's Deletes.
 *   …BUT IT IS AN ORDINARY KEYFRAME TO THE LOCAL TOOL — standing ON slide 3, the
 *     same `active: false` is what that slide says about the widget, so Remove
 *     Keyframes on This Slide clears it and the title reappears.
 *
 * Fails loudly on any NEW console error (pre-existing boot noise is baselined,
 * the palette_probe.js convention).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";
void shots;

// The demo deck's two discriminating items (examples/demo.powerrp.json):
const RECT = "c5c2bed3"; // fill + rotation keyframed on slide 2, never hidden → one run over the whole deck
const TITLE = "5420a650"; // ONLY an `active: false` on slide 3 → visible run 1-2, then gone
const ANIMATED_SLIDE = 1; // 0-based: the slide the rect's keyframes live on
const TITLE_HIDDEN_SLIDE = 2; // 0-based: the slide whose delta switches the title off

/**
 * Console errors this probe is NOT about, filtered rather than baselined because
 * they fire MID-RUN and not only at boot: the project backend (server.py) is not
 * started by a frontend-only probe, so the asset library and the thumbnail/preview
 * fetches answer 500 / ECONNREFUSED whenever a pane happens to refresh. The house
 * allowlist (tests/cursor_overhaul_probe.js, tests/browser_render_harness.js) is
 * copied verbatim so a real error in the editor still fails this run.
 */
const ENVIRONMENT_NOISE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error|VideoV7|WebGPU|no WebGPU adapter/i;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
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
  page.on("console", (m) => { if (m.type() === "error" && !ENVIRONMENT_NOISE.test(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  const cdpPerm = await page.target().createCDPSession();
  await cdpPerm.send("Browser.grantPermissions", {
    origin: `http://127.0.0.1:${port}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await new Promise((r) => setTimeout(r, 600));

  const bootErrors = errors.length;
  const check = (name, cond, detail = "") => { if (!cond) failures.push(`${name}: ${detail}`); };
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  /** Query. A command's live availability plus the sentences it would show. */
  const gate = (id) => page.evaluate((cmdId) => {
    const app = window.__powerrp_app;
    const cmd = app.commands.get(cmdId);
    return { available: !cmd.when || cmd.when(app), requires: cmd.requires ?? null, help: cmd.help ?? null, title: cmd.title };
  }, id);
  /** Query. The DERIVED render tree, reduced to what the painter consumes. The
   *  manifest's purity invariant means equal trees ⇒ equal pixels. */
  const tree = () => page.evaluate(() => JSON.stringify(
    window.__powerrp_app.nodes().map((n) => ({ itemId: n.itemId, type: n.type, world: n.world, mirror: n.mirror ?? null, state: n.state })),
  ));
  /** Query. ONE item's derived state on the current slide, or null when it is not
   *  rendered there (hidden or not yet created). */
  const nodeState = (id) => page.evaluate((itemId) => {
    const n = window.__powerrp_app.nodes().find((x) => x.itemId === itemId);
    return n ? JSON.stringify(n.state) : null;
  }, id);
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const select = (id) => page.evaluate((i) => { window.__powerrp_app.selection = i; }, id);
  const goSlide = (i) => page.evaluate((n) => { window.__powerrp_app.slideIndex = n; }, i);
  const run = (id) => page.evaluate((cmdId) => window.__powerrp_app.runCommand(cmdId), id);
  /**
   * Query. The selection copied as PNG, as a hex digest of the real bytes, or
   * null when the clipboard hands back nothing.
   *
   * NULL IS AN ENVIRONMENT FACT, NOT A RESULT. Headless Chrome's clipboard is
   * shared, so a probe running CONCURRENTLY with another one that also writes an
   * image can read an empty clipboard (measured: palette_probe's own Copy-as-PNG
   * scenario fails the same way under a parallel browser, at pristine HEAD too).
   * The pixel comparison below is therefore a CROSS-CHECK on top of the
   * derived-tree assertion, which is the real invariant and needs no clipboard.
   * An unavailable cross-check is REPORTED, never silently skipped.
   */
  const pngBytes = async () => {
    await run("copy-as-png");
    await settle(500); // GPU render + clipboard write settle
    return page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes("image/png"));
      if (!item) return null;
      const buf = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
      return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
  };

  // ── Scenario 1: both entries exist, are gated, and can explain themselves ───
  const entries = await page.evaluate(() => ["make-static", "remove-slide-keyframes"].map((id) => {
    const c = window.__powerrp_app.commands.get(id);
    return { id, hasWhen: typeof c.when === "function", hasRun: typeof c.run === "function", requires: c.requires, help: c.help, title: c.title };
  }));
  for (const e of entries) {
    check(`${e.id}-registered`, e.hasRun && e.hasWhen, JSON.stringify(e));
    check(`${e.id}-explains-itself`, (e.requires ?? "").length > 20 && (e.help ?? "").length > 20, JSON.stringify(e));
    check(`${e.id}-help-is-not-the-title`, e.help !== e.title);
  }
  // THE REPORTED DEFECT: one title said "Remove … Keyframes" for a sweeping edit, so
  // it read as local. The titles must open with different words (the palette is
  // fuzzy-searched over titles) and each must state its own SCOPE.
  const [sweeping, local] = entries;
  check("titles-open-with-different-words", sweeping.title.split(" ")[0] !== local.title.split(" ")[0],
    `both open with "${sweeping.title.split(" ")[0]}"`);
  check("sweeping-title-states-its-reach", /every slide/i.test(sweeping.title), `title=${JSON.stringify(sweeping.title)}`);
  check("local-title-states-its-reach", /This Slide/.test(local.title), `title=${JSON.stringify(local.title)}`);

  // ── Scenario 2: nothing selected → both unavailable ────────────────────────
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle();
  check("make-static-unavailable-with-no-selection", (await gate("make-static")).available === false);
  check("remove-slide-unavailable-with-no-selection", (await gate("remove-slide-keyframes")).available === false);

  // ── Scenario 3: VISIBILITY IS NOT ANIMATION (Make Static's load-bearing claim) ─
  // The title text's only later keyframe is `active: false` on slide 3, which lies
  // OUTSIDE the visible run containing slide 1 — so from here it is already static.
  // Slide 1 is also the slide that CREATES it, which is what the local tool refuses.
  await goSlide(0);
  await select(TITLE);
  await settle();
  check("title-text-is-already-static-in-its-run", (await gate("make-static")).available === false,
    `gate=${JSON.stringify(await gate("make-static"))}`);
  check("local-tool-refuses-the-creation-slide", (await gate("remove-slide-keyframes")).available === false,
    `gate=${JSON.stringify(await gate("remove-slide-keyframes"))}`);
  const titleKeys = await page.evaluate((id) => window.__powerrp_app.doc.slides.map((s) => Object.keys(s.delta.items?.[id] ?? {})), TITLE);
  check("title-text-really-has-a-later-active-keyframe", JSON.stringify(titleKeys[TITLE_HIDDEN_SLIDE]) === JSON.stringify(["active"]),
    `slide deltas=${JSON.stringify(titleKeys)} — the fixture stopped exercising this case`);

  // ── Scenario 4: MAKE STATIC — nothing visible moves where it was run ───────
  await goSlide(ANIMATED_SLIDE);
  await select(RECT);
  await settle(250);
  check("animated-rect-can-be-made-static", (await gate("make-static")).available === true);
  const before = { doc: await docJson(), tree: await tree(), png: await pngBytes() };

  await run("make-static");
  await settle(400);
  const after = { doc: await docJson(), tree: await tree(), png: await pngBytes() };

  check("make-static-changed-the-document", after.doc !== before.doc, "Make Static wrote nothing");
  check("derived-tree-identical-on-the-invoking-slide", after.tree === before.tree,
    "the render tree changed on the very slide the values were taken from");
  if (before.png && after.png)
    check("png-bytes-identical", after.png === before.png, `${before.png.length} vs ${after.png.length} hex chars`);
  else
    console.warn(`NOTE: the PNG cross-check was unavailable (clipboard returned ${before.png ? "after" : "before"}=null — a concurrent headless browser). The derived-tree assertion above still covers it.`);

  const shape = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    return {
      perSlideKeys: app.doc.slides.map((s) => Object.keys(s.delta.items?.[id] ?? {})),
      runStartFill: app.doc.slides[0].delta.items[id].fill,
      runStartRotation: app.doc.slides[0].delta.items[id].rotation,
      remainingTargets: app.makeStaticTargets(),
    };
  }, RECT);
  check("later-slides-no-longer-key-the-rect", JSON.stringify(shape.perSlideKeys[ANIMATED_SLIDE]) === "[]",
    `perSlideKeys=${JSON.stringify(shape.perSlideKeys)}`);
  check("the-runs-first-slide-now-holds-the-invoking-slide-values", shape.runStartFill === "#2ac3a2" && shape.runStartRotation === 0.3,
    `fill=${shape.runStartFill} rotation=${shape.runStartRotation}`);
  check("nothing-left-to-make-static", shape.remainingTargets.length === 0, `remaining=${JSON.stringify(shape.remainingTargets)}`);

  // IDEMPOTENT at the app level too — and this is also what makes the single undo
  // below unambiguous: a second run must add no undo entry of its own.
  await run("make-static");
  await settle(200);
  check("make-static-second-run-is-a-no-op", (await docJson()) === after.doc, "running it again rewrote the document");

  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(300);
  check("make-static-one-undo-restores-the-document", (await docJson()) === before.doc,
    "undo did not return a JSON-equal document — Make Static is not one undo unit");
  check("make-static-one-undo-restores-the-render-tree", (await tree()) === before.tree);

  // ── Scenario 5: REMOVE KEYFRAMES ON THIS SLIDE — this slide inherits the last ─
  // Standing on the slide whose delta switches the title OFF: that `active: false`
  // is an ordinary keyframe to this tool, so clearing it brings the title back.
  await goSlide(TITLE_HIDDEN_SLIDE - 1);
  await settle(200);
  const titleOnPrevSlide = await nodeState(TITLE);
  check("title-is-rendered-on-the-previous-slide", titleOnPrevSlide !== null);
  await goSlide(TITLE_HIDDEN_SLIDE);
  await select(TITLE);
  await settle(250);
  check("title-is-NOT-rendered-on-the-hidden-slide", (await nodeState(TITLE)) === null);
  check("local-tool-is-available-on-the-hidden-slide", (await gate("remove-slide-keyframes")).available === true,
    `gate=${JSON.stringify(await gate("remove-slide-keyframes"))}`);
  check("make-static-refuses-where-the-item-is-hidden", (await gate("make-static")).available === false,
    "Make Static must refuse a slide the item is not visible on — there is no run to be static over");
  const beforeLocal = { doc: await docJson(), tree: await tree() };

  await run("remove-slide-keyframes");
  await settle(300);
  check("local-tool-changed-the-document", (await docJson()) !== beforeLocal.doc);
  check("this-slide-now-folds-to-the-previous-one", (await nodeState(TITLE)) === titleOnPrevSlide,
    `after=${await nodeState(TITLE)} prev=${titleOnPrevSlide}`);
  const localShape = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    return {
      thisSlideKeys: Object.keys(app.doc.slides[app.slideIndex].delta.items?.[id] ?? {}),
      otherSlideDeltas: app.doc.slides.filter((_, i) => i !== app.slideIndex).map((s) => JSON.stringify(s.delta)),
      remainingTargets: app.slideKeyframeTargets(),
    };
  }, TITLE);
  check("this-slide-no-longer-keys-the-title", JSON.stringify(localShape.thisSlideKeys) === "[]", JSON.stringify(localShape.thisSlideKeys));
  check("nothing-left-to-remove-here", localShape.remainingTargets.length === 0, JSON.stringify(localShape.remainingTargets));
  const otherDeltasBefore = JSON.parse(beforeLocal.doc).slides
    .filter((_, i) => i !== TITLE_HIDDEN_SLIDE).map((s) => JSON.stringify(s.delta));
  check("no-other-slides-delta-was-touched", JSON.stringify(localShape.otherSlideDeltas) === JSON.stringify(otherDeltasBefore),
    "clearing one slide rewrote another one's delta");

  const afterLocal = await docJson();
  await run("remove-slide-keyframes");
  await settle(200);
  check("local-tool-second-run-is-a-no-op", (await docJson()) === afterLocal, "running it again rewrote the document");
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(300);
  check("local-tool-one-undo-restores-the-document", (await docJson()) === beforeLocal.doc,
    "undo did not return a JSON-equal document — the per-slide removal is not one undo unit");
  check("local-tool-one-undo-restores-the-render-tree", (await tree()) === beforeLocal.tree);

  // ── Scenario 6: the palette lists each one, greyed, with its reason ─────────
  // With the title selected on its CREATION slide neither tool can run, which is
  // the state that makes both reasons visible.
  await goSlide(0);
  await select(TITLE);
  await settle();
  for (const [query, id] of [["make static from current slide", "make-static"], ["remove keyframes on this slide", "remove-slide-keyframes"]]) {
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
    await settle();
    await page.type(".palette input", query);
    await settle(200);
    const row = await page.evaluate(() => {
      const el = document.querySelector(".palette-item");
      const help = document.querySelector(".palette-help");
      return {
        id: el?.dataset.commandId ?? null,
        unavailable: !!el?.classList.contains("unavailable"),
        ariaDisabled: el?.getAttribute("aria-disabled") ?? null,
        reason: help?.querySelector(".tool-tip-requires")?.textContent ?? null,
        helpText: help?.querySelector(".palette-help-text")?.textContent ?? null,
      };
    });
    check(`palette-ranks-${id}-first-for-its-own-words`, row.id === id, `query="${query}" row=${JSON.stringify(row)}`);
    check(`palette-${id}-greyed-not-hidden`, row.unavailable && row.ariaDisabled === "true", `row=${JSON.stringify(row)}`);
    check(`palette-${id}-says-why`, /^Unavailable — requires .+/.test(row.reason ?? ""), `reason=${JSON.stringify(row.reason)}`);
    check(`palette-${id}-shows-its-scope`, /THIS SLIDE ONLY|EVERY SLIDE/.test(row.helpText ?? ""), `helpText=${JSON.stringify(row.helpText)}`);
    await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
    await settle();
  }

  // ── Scenario 7: the TOOLS pane carries a Keyframes section with BOTH rows ───
  const pane = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const groups = app.selectedNode()?.plugin?.toolGroups ?? [];
    return {
      ids: groups.map((g) => g.id),
      keyframeRows: (groups.find((g) => g.id === "keyframes")?.rows ?? []).map((r) => r.command),
      headings: [...document.querySelectorAll(".toolspane .cat-head, .toolspane .category-head, .toolspane button")].map((e) => e.textContent.trim()).filter(Boolean),
    };
  });
  check("tools-pane-has-a-keyframes-group", pane.ids.includes("keyframes"), `ids=${JSON.stringify(pane.ids)}`);
  check("keyframes-group-holds-both-commands-local-first",
    JSON.stringify(pane.keyframeRows) === '["remove-slide-keyframes","make-static"]', `rows=${JSON.stringify(pane.keyframeRows)}`);
  check("keyframes-section-is-rendered", pane.headings.some((h) => /Keyframes/.test(h)), `headings=${JSON.stringify(pane.headings)}`);

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during probe: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("KEYFRAME TOOLS PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s))`);
    process.exit(1);
  }
  console.log(`Keyframe tools probe passed: all scenarios green (ignored ${bootErrors} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
