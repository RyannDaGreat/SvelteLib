/**
 * KEYFRAME FREEZE probe — the BROWSER half of tests/keyframe_freeze_test.js.
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/keyframe_freeze_probe.js <shot_dir>
 *
 * WHY A BROWSER PROBE. Three of the claims about "Remove Animation Keyframes"
 * cannot be made in bare node:
 *   - ONE UNDO PUTS IT BACK. The undo log lives on the app (web/app.svelte.js),
 *     and the proof has to be a WHOLE-DOCUMENT comparison through a fresh proxy —
 *     reference identity would pass for free and prove nothing.
 *   - THE PIXELS DO NOT MOVE on the slide it was run from. The manifest's core
 *     invariant is RenderTree = pure(document, [[slide, alpha]]), so the honest
 *     check is the DERIVED TREE, and the belt-and-braces one is real PNG bytes
 *     off the GPU path (Copy Selection as PNG).
 *   - THE SURFACINGS AGREE. Only the booted app holds the whole command registry
 *     and the resolved tool groups; a node test would have to re-list them, which
 *     is the mirrored-shape defect this project keeps rediscovering.
 *
 * THE SEMANTIC CLAIM IT PINS DOWN AT THE UI LEVEL: keyframed VISIBILITY IS NOT
 * ANIMATION. The demo deck's title text carries exactly one later keyframe, an
 * `active: false` on slide 3 — so with it selected the tool must be GREYED, and
 * say why. If that ever flips to enabled, the tool has started silently undoing
 * people's Deletes.
 *
 * Fails loudly on any NEW console error (pre-existing boot noise is baselined,
 * the palette_probe.js convention).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";
void shots;

// The demo deck's two discriminating items (examples/demo.powerrp.json):
const RECT = "c5c2bed3"; // fill + rotation keyframed on slide 2 → freezable
const TITLE = "5420a650"; // ONLY an `active: false` on slide 3 → already static
const ANIMATED_SLIDE = 1; // 0-based: the slide those rect keyframes live on

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const failures = [];
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
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

  /** Query. The command's live availability + the sentence it would show. */
  const gate = () => page.evaluate(() => {
    const app = window.__powerrp_app;
    const cmd = app.commands.get("freeze-keyframes");
    return { available: !cmd.when || cmd.when(app), requires: cmd.requires ?? null, help: cmd.help ?? null, title: cmd.title };
  });
  /** Query. The DERIVED render tree, reduced to what the painter consumes. The
   *  manifest's purity invariant means equal trees ⇒ equal pixels. */
  const tree = () => page.evaluate(() => JSON.stringify(
    window.__powerrp_app.nodes().map((n) => ({ itemId: n.itemId, type: n.type, world: n.world, mirror: n.mirror ?? null, state: n.state })),
  ));
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const select = (id) => page.evaluate((i) => { window.__powerrp_app.selection = i; }, id);
  const goSlide = (i) => page.evaluate((n) => { window.__powerrp_app.slideIndex = n; }, i);
  /**
   * Query. The selection copied as PNG, as a hex digest of the real bytes, or
   * null when the clipboard hands back nothing.
   *
   * NULL IS AN ENVIRONMENT FACT, NOT A RESULT. Headless Chrome's clipboard is
   * shared, so a probe running CONCURRENTLY with another one that also writes an
   * image can read an empty clipboard (measured: palette_probe's own Copy-as-PNG
   * scenario fails the same way under a parallel browser). The pixel comparison
   * below is therefore a CROSS-CHECK on top of the derived-tree assertion, which
   * is the real invariant (RenderTree = pure(document, [[slide, alpha]])) and
   * needs no clipboard at all. An unavailable cross-check is REPORTED, never
   * silently skipped.
   */
  const pngBytes = async () => {
    await page.evaluate(() => window.__powerrp_app.runCommand("copy-as-png"));
    await settle(500); // GPU render + clipboard write settle
    return page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes("image/png"));
      if (!item) return null;
      const buf = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
      return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
  };

  // ── Scenario 1: the entry exists, is gated, and can explain itself ──────────
  const registered = await page.evaluate(() => {
    const c = window.__powerrp_app.commands.get("freeze-keyframes");
    return { hasWhen: typeof c.when === "function", hasRun: typeof c.run === "function", requires: c.requires, help: c.help, title: c.title };
  });
  check("command-registered", registered.hasRun && registered.hasWhen, JSON.stringify(registered));
  check("command-explains-itself", (registered.requires ?? "").length > 20 && (registered.help ?? "").length > 20, JSON.stringify(registered));
  check("help-is-not-the-title", registered.help !== registered.title);

  // ── Scenario 2: nothing selected → unavailable ──────────────────────────────
  await page.evaluate(() => { window.__powerrp_app.selection = null; });
  await settle();
  check("unavailable-with-no-selection", (await gate()).available === false);

  // ── Scenario 3: VISIBILITY IS NOT ANIMATION (the load-bearing claim) ────────
  // The title text's only later keyframe is `active: false`. If this ever reads
  // available, the tool has started collapsing people's Deletes.
  await goSlide(0);
  await select(TITLE);
  await settle();
  const titleGate = await gate();
  check("title-text-is-already-static", titleGate.available === false, `gate=${JSON.stringify(titleGate)}`);
  const titleKeys = await page.evaluate((id) => window.__powerrp_app.doc.slides.map((s) => Object.keys(s.delta.items?.[id] ?? {})), TITLE);
  check("title-text-really-has-a-later-active-keyframe", JSON.stringify(titleKeys[2]) === JSON.stringify(["active"]),
    `slide deltas=${JSON.stringify(titleKeys)} — the fixture stopped exercising this case`);

  // ── Scenario 4: the animated rect IS freezable, and nothing visible moves ───
  await goSlide(ANIMATED_SLIDE);
  await select(RECT);
  await settle(250);
  check("animated-rect-is-freezable", (await gate()).available === true);
  const before = { doc: await docJson(), tree: await tree(), png: await pngBytes() };

  await page.evaluate(() => window.__powerrp_app.runCommand("freeze-keyframes"));
  await settle(400);
  const after = { doc: await docJson(), tree: await tree(), png: await pngBytes() };

  check("document-changed", after.doc !== before.doc, "the freeze wrote nothing");
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
      creationFill: app.doc.slides[0].delta.items[id].fill,
      creationRotation: app.doc.slides[0].delta.items[id].rotation,
      remainingTargets: app.freezeKeyframeTargets(),
    };
  }, RECT);
  check("later-slides-no-longer-key-the-rect", JSON.stringify(shape.perSlideKeys[ANIMATED_SLIDE]) === "[]",
    `perSlideKeys=${JSON.stringify(shape.perSlideKeys)}`);
  check("creation-slide-now-holds-the-invoking-slide-values", shape.creationFill === "#2ac3a2" && shape.creationRotation === 0.3,
    `fill=${shape.creationFill} rotation=${shape.creationRotation}`);
  check("nothing-left-to-freeze", shape.remainingTargets.length === 0, `remaining=${JSON.stringify(shape.remainingTargets)}`);

  // IDEMPOTENT at the app level too — and this is also what makes the single undo
  // below unambiguous: a second run must add no undo entry of its own.
  await page.evaluate(() => window.__powerrp_app.runCommand("freeze-keyframes"));
  await settle(200);
  check("second-run-is-a-no-op", (await docJson()) === after.doc, "running it again rewrote the document");

  // ── Scenario 5: ONE UNDO restores a JSON-EQUAL document ─────────────────────
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(300);
  check("one-undo-restores-the-document", (await docJson()) === before.doc,
    "undo did not return a JSON-equal document — the freeze is not one undo unit");
  check("one-undo-restores-the-render-tree", (await tree()) === before.tree);

  // ── Scenario 6: the palette lists it, greyed, with its reason, when gated ───
  await select(TITLE);
  await settle();
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = true; });
  await settle();
  await page.type(".palette input", "remove animation keyframes");
  await settle(200);
  const row = await page.evaluate(() => {
    const el = document.querySelector(".palette-item");
    const help = document.querySelector(".palette-help");
    return {
      id: el?.dataset.commandId ?? null,
      title: el?.querySelector(".title")?.textContent ?? null,
      unavailable: !!el?.classList.contains("unavailable"),
      ariaDisabled: el?.getAttribute("aria-disabled") ?? null,
      reason: help?.querySelector(".tool-tip-requires")?.textContent ?? null,
      helpText: help?.querySelector(".palette-help-text")?.textContent ?? null,
    };
  });
  check("palette-finds-it-by-the-words-the-user-would-type", row.id === "freeze-keyframes", `row=${JSON.stringify(row)}`);
  check("palette-row-greyed-not-hidden", row.unavailable && row.ariaDisabled === "true", `row=${JSON.stringify(row)}`);
  check("palette-row-says-why", /^Unavailable — requires .+/.test(row.reason ?? ""), `reason=${JSON.stringify(row.reason)}`);
  check("palette-row-shows-the-consequence", (row.helpText ?? "").includes("visibility"), `helpText=${JSON.stringify(row.helpText)}`);
  await page.evaluate(() => { window.__powerrp_app.paletteOpen = false; });
  await settle();

  // ── Scenario 7: the TOOLS pane carries a Keyframes section for the widget ───
  const pane = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const groups = app.selectedNode()?.plugin?.toolGroups ?? [];
    return {
      ids: groups.map((g) => g.id),
      keyframeRows: (groups.find((g) => g.id === "keyframes")?.rows ?? []).map((r) => r.command),
      titles: groups.map((g) => g.title),
      headings: [...document.querySelectorAll(".toolspane .cat-head, .toolspane .category-head, .toolspane button")].map((e) => e.textContent.trim()).filter(Boolean),
    };
  });
  check("tools-pane-has-a-keyframes-group", pane.ids.includes("keyframes"), `ids=${JSON.stringify(pane.ids)}`);
  check("keyframes-group-holds-the-command", JSON.stringify(pane.keyframeRows) === '["freeze-keyframes"]', `rows=${JSON.stringify(pane.keyframeRows)}`);
  check("keyframes-section-is-rendered", pane.headings.some((h) => /Keyframes/.test(h)), `headings=${JSON.stringify(pane.headings)}`);

  const newErrors = errors.slice(bootErrors);
  if (newErrors.length) failures.push(`console errors during probe: ${newErrors.join(" | ")}`);

  if (failures.length) {
    console.error("KEYFRAME FREEZE PROBE FAILURES:\n" + failures.join("\n"));
    if (bootErrors) console.error(`(ignored ${bootErrors} pre-existing boot error(s))`);
    process.exit(1);
  }
  console.log(`Keyframe freeze probe passed: all scenarios green (ignored ${bootErrors} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
