/**
 * PPTX PRESET SHAPE widget probe — the REAL editor, boots a real item, reads
 * its real Inspector rows, drives a REAL pointer drag (page.mouse, routed
 * through CanvasView's actual pointer-capture handlers — the same technique
 * tests/modifier_probe.js uses for the donut's inner-rim handle) on its
 * on-canvas handle, and checks the committed document actually changed.
 * Reading `page.evaluate`d core state alone would only prove the pure
 * functions agree with themselves; a real mouse gesture proves the widget is
 * actually wired into the live plugin registry, CanvasView's drag machinery,
 * and the undo/preview pipeline.
 *
 * Frontend-only Vite on an EPHEMERAL port (never 3637/3638), swiftshader GL —
 * same harness as tests/multiselect_inspector_probe.js and
 * tests/modifier_probe.js, followed exactly (worldToPage via
 * `app.canvasActions.worldToScreen` + the `.overlay` bounding rect; world
 * position of a LOCAL modifier point via `core/transform.js`'s own `apply`,
 * computed in Node exactly as tests/modifier_probe.js does for the donut).
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/preset_widget_probe.js
 */
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import * as T from "../core/transform.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const assert = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails.push(m); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  const liveErrors = [];
  const afterBoot = { on: false };
  page.on("console", (m) => { if (m.type() === "error" && afterBoot.on) liveErrors.push(m.text()); });
  await page.goto(baseUrl, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(1500);
  afterBoot.on = true;

  // ── 1. THE TYPE IS REGISTERED, WITH THE RIGHT SHAPE OF DEFAULTS ────────────
  const registered = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const plugin = app.registry.get("pptxPreset");
    return {
      found: !!plugin,
      title: plugin?.title ?? null,
      presetOptionsCount: plugin?.inspector?.find((r) => r.key === "preset")?.options?.length ?? 0,
      defaultsAdj: plugin?.defaults?.adj ?? null,
      defaultsPreset: plugin?.defaults?.preset ?? null,
    };
  });
  assert(registered.found, "pptxPreset is registered in the live plugin registry");
  assert(registered.title === "PowerPoint Shape", `title reads "PowerPoint Shape" (got ${JSON.stringify(registered.title)})`);
  assert(registered.presetOptionsCount === 187, `the Shape row offers all 187 preset names (got ${registered.presetOptionsCount})`);
  assert(registered.defaultsPreset === "roundRect", `defaults to roundRect (got ${JSON.stringify(registered.defaultsPreset)})`);
  assert(JSON.stringify(registered.defaultsAdj) === '{"adj":16667}', `roundRect's one adjustment defaults to PowerPoint's own named guide "adj" = 16667 (got ${JSON.stringify(registered.defaultsAdj)})`);

  // ── 2. ADDING ONE VIA THE REAL COMMAND RENDERS A NON-EMPTY PICTURE ──────────
  const setup = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    const plugin = app.registry.all().find((p) => (p.commands ?? []).some((c) => c.id === "add-pptx-preset"));
    app.addItem(plugin.defaults);
    const id = app.selection;
    app.setPreview([[["items", id, "x"], 300], [["items", id, "y"], 300], [["items", id, "w"], 240], [["items", id, "h"], 160]]);
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    const mp = node.plugin.modifierPoints(node.state)[0];
    return { id, world: node.world, mpLocal: { x: mp.x, y: mp.y }, mpId: mp.id, opsD: app.registry.get("pptxPreset").emit(node.state, null, node.world)[0]?.d ?? null };
  });
  assert(typeof setup.id === "string" && setup.id.length > 0, `an item was added via the real "add-pptx-preset" command (id ${JSON.stringify(setup.id)})`);
  assert(typeof setup.opsD === "string" && setup.opsD.length > 0, "emit() produced real SVG path data through the live node");
  await sleep(400);

  // ── 3. THE ON-CANVAS HANDLE IS AT THE HAND-COMPUTED POSITION ────────────────
  // roundRect's one handle: x1 = ss*adj/100000, ss=min(w,h)=min(240,160)=160,
  // default adj=16667 -> x1 = 160*16667/100000 ~= 26.667, y=0 (box-local).
  assert(Math.abs(setup.mpLocal.x - (160 * 16667) / 100000) < 0.01, `handle local x matches the hand-computed roundRect formula (got ${setup.mpLocal.x})`);
  assert(Math.abs(setup.mpLocal.y - 0) < 0.01, `handle local y is 0, the box's top edge (got ${setup.mpLocal.y})`);

  // ── 4. A REAL MOUSE DRAG on the handle changes the COMMITTED adj ────────────
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  // READS MUST (1) go through app.doc's DELTA directly for "is it COMMITTED
  // yet" — NOT app.rawState(), which is DOCUMENTED to blend the live preview
  // on top ("Folded state of the current slide, with any live drag preview
  // applied" — its own docstring), so it cannot distinguish committed from
  // mid-drag; that confusion cost a real debugging round here: `rawState()`
  // read the DRAGGED value mid-drag even though nothing had committed yet,
  // because it was never meant to answer that question. And (2) FORCE A
  // PLAIN SNAPSHOT (JSON.parse(JSON.stringify(...))) BEFORE RETURNING — a
  // Svelte 5 $state proxy (which app.doc's/previewDelta's NESTED OBJECT
  // trees are) reads back as `{}` across the Puppeteer CDP boundary once
  // execution leaves the evaluate() call that touched it (documented in
  // tests/multiselect_inspector_probe.js's own header: "never a raw stored
  // opacity as plain numbers — those serialize to {} across the puppeteer
  // boundary" — that precedent is about a SCALAR reading `{}`; the nested-
  // object case measured here is the same underlying trap, one level
  // deeper). Proven with core/rect.js's unrelated `shadow` object too — ANY
  // nested property on ANY widget hits this, nothing specific to this one.
  const docAdj = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.__powerrp_app.doc.slides[window.__powerrp_app.slideIndex].delta.items?.[id]?.adj ?? null)), id);
  const previewAdj = (id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.__powerrp_app.previewDelta?.items?.[id]?.adj ?? null)), id);

  const w0 = T.apply(setup.world, setup.mpLocal.x, setup.mpLocal.y);
  const p0 = await worldToPage(w0.x, w0.y);
  // Drag 40 world units further right along the box (well inside the 240-wide
  // box, away from either clamp) — the corner-radius handle only moves along
  // the top edge (gdRefX only, no gdRefY on this handle), so a pure-X target
  // is the geometrically correct drag direction.
  const target = await worldToPage(w0.x + 40, w0.y);
  // BASELINE IS THE EXPLICIT DEFAULT, NOT UNDEFINED: `app.addItem(plugin.defaults)`
  // stores `adj: {adj: 16667}` directly as committed doc state (defaults are
  // written verbatim, not merge-on-read) — so "unchanged mid-drag" means "still
  // exactly the default", not "absent". PowerPoint's own guide NAME for
  // roundRect's one adjustment is literally "adj" (not a numbered slot).
  const before = { doc: await docAdj(setup.id) };
  assert(JSON.stringify(before.doc) === '{"adj":16667}', `baseline: doc adj is the explicit default (got ${JSON.stringify(before.doc)})`);

  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move((p0.x + target.x) / 2, (p0.y + target.y) / 2, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 4 });
  const mid = { doc: await docAdj(setup.id), preview: await previewAdj(setup.id) };
  assert(JSON.stringify(mid.doc) === JSON.stringify(before.doc), `mid-drag: committed doc adj UNCHANGED (still ${JSON.stringify(mid.doc)})`);
  assert(mid.preview && typeof mid.preview["adj"] === "number", `mid-drag: preview adj.adj is a live number (${JSON.stringify(mid.preview)})`);
  await page.mouse.up();
  await sleep(300);

  const after = { doc: await docAdj(setup.id), preview: await previewAdj(setup.id) };
  console.log("  ..  committed adj after drag:", JSON.stringify(after.doc));
  assert(after.doc && typeof after.doc["adj"] === "number", `commit: doc.adj.adj was written (${JSON.stringify(after.doc)})`);
  assert(after.doc?.["adj"] !== 16667, `the committed value differs from the untouched default 16667 (got ${after.doc?.["adj"]})`);
  assert(after.preview === null, "commit: preview cleared");

  const undone = await page.evaluate((id) => JSON.parse(JSON.stringify((() => {
    const app = window.__powerrp_app;
    app.undo();
    return app.doc.slides[app.slideIndex].delta.items?.[id]?.adj ?? null;
  })())), setup.id);
  assert(JSON.stringify(undone) === JSON.stringify(before.doc), `ONE undo unit restores adj to its pre-drag value — got ${JSON.stringify(undone)}`);
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(200);

  // ── 5. A FRESH "pie" ITEM OFFERS ITS OWN TWO ANGLE HANDLES, AND A FRESH
  //        "rect" ITEM (no ahLst) OFFERS ZERO ─────────────────────────────────
  // Fresh items rather than switching `preset` on the existing one: writing
  // `adj: {}` through setPreview/commitPreview is a NO-OP for clearing a
  // PRIOR preset's stale adj keys — commitPreview's walk only visits LEAVES
  // (`Object.entries(tree)`), so an EMPTY object at a branch keyframes
  // nothing at all, leaving roundRect's `{adj: <dragged value>}` sitting
  // underneath a `pie` item that expects `adj1`/`adj2` — exactly the
  // `foldGuides: adjustment "adj" does not exist on this shape's avLst` throw
  // this probe hit before switching to fresh items. That is a real property
  // of commitPreview's own leaf-walk semantics (worth knowing for a future
  // "preset switch" Inspector affordance), not a defect in this widget: a
  // fresh item never has a stale cross-preset key to begin with.
  const pieHandles = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("pptxPreset").defaults, preset: "pie", adj: {} });
    const node = app.nodes().find((n) => n.itemId === app.selection);
    return app.registry.get("pptxPreset").modifierPoints(node.state).length;
  });
  assert(pieHandles === 2, `a fresh "pie" item offers its own TWO angle handles (got ${pieHandles})`);

  const rectHandles = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("pptxPreset").defaults, preset: "rect", adj: {} });
    const node = app.nodes().find((n) => n.itemId === app.selection);
    return app.registry.get("pptxPreset").modifierPoints(node.state).length;
  });
  assert(rectHandles === 0, `a fresh "rect" item (no ahLst) offers ZERO on-canvas handles (got ${rectHandles})`);

  assert(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nPASS — pptx_preset widget (real editor)");
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
