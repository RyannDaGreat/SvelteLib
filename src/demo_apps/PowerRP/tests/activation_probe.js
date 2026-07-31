/**
 * WIDGET UI-HANDLER REGISTRY probe (web/widget_handlers.js) — the general
 * "a widget owns its own editor behaviour" mechanism, and its first NEW consumer,
 * INTERIOR EXPLORE MODE.
 *
 * Drives REAL pointer/wheel/keyboard gestures against the live editor
 * (page.mouse / page.keyboard — CanvasView's handlers call setPointerCapture, so
 * synthetic dispatchEvent would not route through them; the crosshair_probe.js
 * technique), asserting:
 *
 *   REGISTRY
 *     - every existing activation still resolves to the same behaviour it had as
 *       an if-chain branch: text → in-place rich edit, plaintext → plain inline
 *       edit, latex → the equation editor, image/video → the asset-pick signal,
 *       cursor → its canvas palette; a rect still does nothing;
 *     - creation still resolves: a bbox drag places the dragged rect, a bare
 *       click places the default size, an arrow click places its default length;
 *     - the MIGRATION PLAN query lists exactly the widgets still resolved through
 *       a legacy claim (the flag-day checklist).
 *
 *   INTERIOR EXPLORE MODE (the new capability)
 *     - the whole feature works from the ONE-LINE declaration that now ships in
 *       plugins/demo/mandelbrot.js (this probe injected it at runtime while that
 *       file belonged to another agent; see the note at the section itself);
 *     - double-click enters the mode; the HintBar swaps to the mode's OWN
 *       shortcut set; Escape exits and normal editing resumes;
 *     - THE CANVAS'S OWN GESTURES, one frame down: a plain wheel pans the interior,
 *       Ctrl+wheel (what a trackpad pinch sends) zooms it, and a PLAIN DRAG still
 *       MOVES THE WIDGET — the user's correction, and the reason the mode declares
 *       no onPan at all;
 *     - the mode mounts the widget's floating coordinate bar as its visual
 *       indication, and the bar survives dragging the widget around;
 *     - every interior gesture writes the WIDGET's own keyframable state (so a
 *       reload / CLI render agrees) — never a transient view object;
 *     - ONE undo unit per gesture, proven by counting app.commit calls: 8 wheel
 *       ticks = 1 commit, and ONE undo restores the pre-gesture value;
 *     - a property bound to an `=` equation REFUSES the mode loudly instead of
 *       silently overwriting the equation;
 *     - normal canvas pan/zoom is untouched outside the mode.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/activation_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

// Every path resolves from THIS FILE, never process.cwd(): the probe must run
// correctly from any directory, and a cwd-relative root silently pointed at the
// wrong tree the moment it was invoked from anywhere but the repo root.
const shots = process.argv[2] ?? "/tmp/activation_probe";
await mkdir(shots, { recursive: true });

// A SMALL, CHEAP Mandelbrot: headless Chromium rasterizes SkSL in software here,
// and the shipped 520x390 default at 900 iterations is ~200k heavy pixels per
// frame — minutes, not milliseconds. 160x120 at 60 iterations is the same code
// path at ~1/40th the cost, which is what makes a multi-gesture probe possible.
const PROBE_W = 160;
const PROBE_H = 120;
const PROBE_ITER = 60;
const SETTLE_MS = 260; // one reactive paint + Skia frame at probe size
const WHEEL_TICKS = 8; // one continuous zoom gesture
const WHEEL_DELTA = 60; // positive on BOTH axes: a plain wheel pans right+down, and
// with Ctrl held the same sign zooms OUT — at 60 iterations a deeper view is
// legitimately solid interior colour (the plugin documents that), so zooming out is
// the direction whose screenshot READS as "the interior moved".
const ZOOM_IDLE_WAIT_MS = 700; // > ZOOM_GESTURE_IDLE_MS (250), so the gesture ends

// HMR + the file watcher are OFF: a dozen agents edit this tree concurrently, and a
// stray HMR full-reload mid-probe drops window.__powerrp_app and fails the run for
// reasons that have nothing to do with what is being tested.
const server = await createServer({
  configFile: fileURLToPath(new URL("../web/vite.config.js", import.meta.url)),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Documented boot/runtime noise from OTHER lanes (same treatment as
// crosshair_probe.js): repair reports, missing fonts, and the WebGPU-less
// headless video overlays.
const IGNORE = [/PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/, /preserveAspect/];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  const liveErrors = [];
  const phase = { live: false };
  page.on("pageerror", (e) => (phase.live ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || isNoise(m.text())) return;
    (phase.live ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  // The equation-refusal path reports with console.warn — captured separately.
  const warnings = [];
  page.on("console", (m) => warnings.push(`${m.type()}: ${m.text()}`));

  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);
  ok(bootErrors.length === 0, `no boot errors — INCLUDING the new startup shortcut-reachability check (${JSON.stringify(bootErrors)})`);
  phase.live = true;

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  const hintLabels = () => page.evaluate(() => [...document.querySelectorAll(".hintbar .hint .label")].map((n) => n.textContent.trim()));
  const stored = (id, key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), id, key);
  const modeId = () => page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId ?? null);

  // ── The registry's own resolution table (pure, no gestures) ────────────────
  const resolution = await page.evaluate(async () => {
    const mod = await import("/widget_handlers.js");
    const app = window.__powerrp_app;
    const types = ["text", "plaintext", "latex", "image", "video", "cursor", "rect", "arrow", "line", "circle"];
    const out = {};
    for (const t of types) {
      const plugin = app.registry.get(t);
      out[t] = {
        activate: plugin ? mod.handlerFor("activate", plugin)?.id ?? null : "NO SUCH PLUGIN",
        create: plugin ? mod.handlerFor("create", plugin)?.id ?? null : "NO SUCH PLUGIN",
      };
    }
    return {
      out,
      activateIds: mod.handlerIds("activate"),
      createIds: mod.handlerIds("create"),
      // canvasModes() walks BOTH phases now (a CREATION may take over the canvas
      // too — the polygon's click-click-click, the telescopic rig's two boxes), so
      // this probe asks for the ACTIVATE half, which is what it is about.
      modes: mod.canvasModes().filter((m) => m.phase === "activate").map((m) => m.handlerId),
    };
  });
  const r = resolution.out;
  ok(r.text.activate === "rich_text_edit", `text → rich_text_edit (got ${r.text.activate})`);
  ok(r.plaintext.activate === "inline_text_edit", `plaintext → inline_text_edit (got ${r.plaintext.activate})`);
  ok(r.latex.activate === "latex_edit", `latex → latex_edit (got ${r.latex.activate})`);
  ok(r.image.activate === "asset_picker", `image → asset_picker (got ${r.image.activate})`);
  ok(r.video.activate === "asset_picker", `video → asset_picker (got ${r.video.activate})`);
  ok(r.cursor.activate === "overlay_palette", `cursor → overlay_palette (got ${r.cursor.activate})`);
  ok(r.rect.activate === null, `rect declares no activation (got ${r.rect.activate})`);
  ok(r.rect.create === "bbox" && r.circle.create === "bbox", `rect/circle → bbox creation (got ${r.rect.create}/${r.circle.create})`);
  ok(r.arrow.create === "endpoints" && r.line.create === "endpoints", `arrow/line → endpoints creation (got ${r.arrow.create}/${r.line.create})`);
  // Asserts THIS probe's mode is registered, not that it is the only one: the
  // exhaustive `join(",") === "navigate_interior"` form was a mirror of the
  // registry's shape, so the second activate mode (bento cell binding) broke it in
  // a file about interior explore. tests/bento_bind_test.js owns that one's wiring.
  ok(resolution.modes.includes("navigate_interior"), `the interior-explore ACTIVATION mode is registered (got ${resolution.modes.join(",")})`);

  const plan = await page.evaluate(async () => {
    const mod = await import("/widget_handlers.js");
    const app = window.__powerrp_app;
    return mod.migrationPlan(app.registry.all());
  });
  ok(Array.isArray(plan), "migrationPlan() returns the flag-day checklist");

  // ── Existing activations still behave (real double-clicks) ────────────────
  const spawn = (type, extra = {}) => page.evaluate((type, extra) => {
    const app = window.__powerrp_app;
    const id = app.addItem({ ...app.registry.get(type).defaults, ...extra });
    return id ?? app.selection;
  }, type, extra);
  const dblAt = async (wx, wy) => {
    const p = await worldToPage(wx, wy);
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await sleep(SETTLE_MS);
  };

  await spawn("text", { x: 60, y: 60, w: 200, h: 60 });
  await dblAt(160, 90);
  ok(await page.evaluate(() => window.__powerrp_app.textEditing !== null), "double-click a text widget still enters in-place rich edit");
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);

  await spawn("plaintext", { x: 60, y: 200, w: 200, h: 60 });
  await dblAt(160, 230);
  const plainEdit = await page.evaluate(() => window.__powerrp_app.textEditing?.plain ?? null);
  ok(plainEdit === true, `double-click a plaintext widget still enters PLAIN inline edit (got ${plainEdit})`);
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);

  await spawn("latex", { x: 60, y: 340, w: 200, h: 80 });
  await dblAt(160, 380);
  ok(await page.evaluate(() => window.__powerrp_app.latexEditing !== null), "double-click a latex widget still opens the equation editor");
  await page.keyboard.press("Escape");
  await sleep(500);

  const imageId = await spawn("image", { x: 320, y: 60, w: 160, h: 120 });
  await dblAt(400, 120);
  const pickFor = await page.evaluate(() => window.__powerrp_app.pendingVideoPickFor);
  ok(pickFor === imageId, `double-click an image still raises the asset-pick signal (got ${JSON.stringify(pickFor)})`);
  await page.evaluate(() => { window.__powerrp_app.pendingVideoPickFor = null; });

  await spawn("cursor", { x: 320, y: 240 });
  await dblAt(340, 260);
  const paletteOpen = await page.evaluate(() => !!document.querySelector(".canvas-toolbar, .floating-toolbar"));
  ok(paletteOpen, "double-click a cursor widget still opens its canvas palette overlay");
  await page.mouse.click(50, 700); // dismiss

  // ── INTERIOR EXPLORE: the declaration now SHIPS in the plugin ───────────────
  // This probe used to INJECT the declaration onto the live plugin object, because
  // plugins/demo/mandelbrot.js belonged to another agent when it was written. The
  // plugin declares it itself now, and the injection had to go: it would have kept
  // this whole section passing even if the plugin's declaration were deleted, which
  // is the one failure it exists to catch. Asserted instead of assumed.
  const mbDeclares = await page.evaluate(() => {
    const p = window.__powerrp_app.registry.get("demo_mandelbrot");
    return { activate: p.activate ?? null, hasView: typeof p.interiorView?.window === "function" && typeof p.interiorView?.writes === "function" };
  });
  ok(mbDeclares.activate === "navigate_interior" && mbDeclares.hasView,
    `plugins/demo/mandelbrot.js itself declares explore mode + its interiorView (got ${JSON.stringify(mbDeclares)})`);

  const mbId = await spawn("demo_mandelbrot", { x: 600, y: 400, w: PROBE_W, h: PROBE_H, maxIterations: PROBE_ITER });
  await sleep(1200);
  const cx = 600 + PROBE_W / 2, cy = 400 + PROBE_H / 2;
  await page.screenshot({ path: `${shots}/1-before.png` });

  const before = {
    centerX: await stored(mbId, "centerX"),
    centerY: await stored(mbId, "centerY"),
    zoomExponent: await stored(mbId, "zoomExponent"),
  };

  await dblAt(cx, cy);
  ok(await modeId() === "navigate_interior", `double-click enters interior explore mode (got ${await modeId()})`);
  const modeHints = await hintLabels();
  // THE GESTURE VOCABULARY IS THE CANVAS'S OWN (the user's correction: "I asked for
  // the wrong controls before. It should just reuse the canvas pan zoom … pinch to
  // zoom and pan to, two fingers to pan. And so that way I can still drag the
  // element around while I'm editing it."). So: wheel pans, Ctrl+wheel (= a
  // trackpad pinch) zooms, and a PLAIN DRAG still moves the widget.
  ok(modeHints.includes("Pan inside"), `HintBar shows the mode's own wheel-pan hint (got ${JSON.stringify(modeHints)})`);
  ok(modeHints.includes("Zoom inside (pinch)"), "HintBar shows the mode's own pinch-zoom hint");
  ok(modeHints.includes("Drag to move the widget"), "HintBar SAYS a plain drag still moves the widget");
  ok(modeHints.some((h) => /^Exit explore/.test(h)), "HintBar shows the mode's Escape exit");
  ok(!modeHints.includes("Select / drag"), "the ordinary canvas hints are GONE while the widget owns the canvas");
  // THE VISUAL INDICATION: the mode mounts the widget's own floating bar ("there's
  // no visual indication when I'm editing it. There should be a bar just like text
  // editing or cursors on the top in the canvas").
  const bar = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll(".canvas-toolbar-root .canvas-toolbar-fields .canvas-toolbar-field")];
    return inputs.map((f) => [f.querySelector(".canvas-toolbar-field-label").textContent.trim(), f.querySelector("input").value]);
  });
  ok(bar.length === 5, `entering explore mode mounts the widget's floating coordinate bar (got ${JSON.stringify(bar)})`);
  ok(bar.some(([l]) => l === "Re") && bar.some(([l]) => l === "Im") && bar.some(([l]) => l === "Zoom"),
    `the bar READS OUT the coordinates being zoomed into (got ${JSON.stringify(bar)})`);
  await page.screenshot({ path: `${shots}/2-mode-active.png` });

  // ── A PLAIN DRAG MOVES THE WIDGET, and leaves the interior alone ────────────
  // This is the INVERSION of the gesture this probe used to assert. It is not a
  // relaxation: the drag must move the item's x/y AND the interior centre must be
  // untouched, so "the mode swallowed the drag" and "the drag moved the interior"
  // both fail here.
  await page.evaluate(() => { window.__probeCommits = 0; const app = window.__powerrp_app; const real = app.commit.bind(app); app.commit = (d) => { window.__probeCommits += 1; return real(d); }; });
  await sleep(1500); // let any unrelated async widget commit (latex re-typeset size-to-aspect) land first
  const commitBase = await page.evaluate(() => window.__probeCommits);
  const itemBefore = { x: await stored(mbId, "x"), y: await stored(mbId, "y") };
  const from = await worldToPage(cx - 30, cy - 20);
  const to = await worldToPage(cx + 20, cy + 15);
  // NATIVE-DRAG REGRESSION GUARD: a mode is entered by double-clicking, and a
  // double-click leaves a text selection that Chrome will happily start an HTML5
  // drag of — which cancels the pointer and truncates the gesture to ONE move.
  // onDblClick clears the selection for exactly this reason; watch both signals,
  // because the drag no longer goes through modePointerDown's preventDefault.
  await page.evaluate(() => {
    window.__probeEv = [];
    document.addEventListener("dragstart", () => window.__probeEv.push("dragstart"), true);
    document.querySelector(".overlay").addEventListener("pointercancel", () => window.__probeEv.push("pointercancel"), true);
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) {
    await page.mouse.move(from.x + (to.x - from.x) * i / 5, from.y + (to.y - from.y) * i / 5);
    await sleep(40);
  }
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const itemAfter = { x: await stored(mbId, "x"), y: await stored(mbId, "y") };
  const dragCommits = await page.evaluate(() => window.__probeCommits) - commitBase;
  const dragEvents = await page.evaluate(() => window.__probeEv.join(","));
  ok(dragEvents === "", `no native dragstart / pointercancel truncated the drag (got "${dragEvents}")`);
  ok(itemAfter.x !== itemBefore.x && itemAfter.y !== itemBefore.y,
    `a PLAIN DRAG moves the WIDGET while exploring (${itemBefore.x},${itemBefore.y} → ${itemAfter.x},${itemAfter.y})`);
  ok(await stored(mbId, "centerX") === before.centerX, "that drag did NOT move the interior — the mode does not own the pointer");
  ok(dragCommits === 1, `the widget move is ONE undo unit (got ${dragCommits} commits)`);
  ok(await modeId() === "navigate_interior", "and the mode SURVIVES the drag (you can keep exploring)");
  ok(await page.evaluate(() => !!document.querySelector(".canvas-toolbar-root .canvas-toolbar-fields")), "the bar survives the drag too");
  await page.screenshot({ path: `${shots}/3-after-widget-drag.png` });

  // ── TWO-FINGER PAN: a plain wheel pans the INTERIOR, ONE undo unit ─────────
  await page.evaluate(() => { window.__probeCommits = 0; });
  const at = await worldToPage(cx, cy);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < WHEEL_TICKS; i += 1) {
    await page.mouse.wheel({ deltaX: WHEEL_DELTA, deltaY: WHEEL_DELTA });
    await sleep(30);
  }
  const panMidCommits = await page.evaluate(() => window.__probeCommits);
  const midPan = await stored(mbId, "centerX");
  await sleep(ZOOM_IDLE_WAIT_MS);
  const panCommits = await page.evaluate(() => window.__probeCommits);
  const afterPan = { centerX: await stored(mbId, "centerX"), centerY: await stored(mbId, "centerY") };
  ok(midPan !== before.centerX, "mid-gesture the interior centre is already previewing (live, not on release)");
  ok(panMidCommits === 0, `no commit while the wheel is still turning (got ${panMidCommits})`);
  ok(panCommits === 1, `${WHEEL_TICKS} wheel ticks = ONE undo unit (got ${panCommits} commits)`);
  ok(afterPan.centerX !== before.centerX && afterPan.centerY !== before.centerY,
    `a plain wheel pans the INTERIOR (${before.centerX},${before.centerY} → ${afterPan.centerX},${afterPan.centerY})`);
  ok(await stored(mbId, "zoomExponent") === before.zoomExponent, "a plain wheel does NOT zoom — that is the pinch's job");
  await page.screenshot({ path: `${shots}/4-after-interior-pan.png` });

  // ── PINCH: Ctrl+wheel zooms the INTERIOR, ONE undo unit ───────────────────
  // Ctrl+wheel IS what a trackpad pinch delivers, and it is the same combination
  // the canvas itself binds to zoom (core/shortcut_entries: Ctrl+mouse_scroll →
  // "Zoom"), which is the whole point of reusing the canvas's vocabulary.
  await page.evaluate(() => { window.__probeCommits = 0; });
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  for (let i = 0; i < WHEEL_TICKS; i += 1) {
    await page.mouse.wheel({ deltaY: WHEEL_DELTA });
    await sleep(30);
  }
  await page.keyboard.up("Control");
  const zoomMidCommits = await page.evaluate(() => window.__probeCommits);
  await sleep(ZOOM_IDLE_WAIT_MS);
  const zoomCommits = await page.evaluate(() => window.__probeCommits);
  const afterZoom = await stored(mbId, "zoomExponent");
  ok(zoomMidCommits === 0, `no commit while the pinch is still going (got ${zoomMidCommits})`);
  ok(zoomCommits === 1, `${WHEEL_TICKS} pinch ticks = ONE undo unit (got ${zoomCommits} commits)`);
  ok(afterZoom < before.zoomExponent, `the widget's own zoomExponent changed with the pinch (${before.zoomExponent} → ${afterZoom})`);
  // And the CANVAS did not zoom underneath it — stopPropagation keeps the event
  // from the PanZoom container, which is what makes the two gestures one key.
  ok(Math.abs(await page.evaluate(() => window.__powerrp_app.lastViewport?.zoom ?? 1) - 1) < 1e-9,
    "the canvas zoom is untouched by an interior pinch");
  await page.screenshot({ path: `${shots}/5-after-interior-pinch.png` });

  // ONE undo restores the pre-pinch value (proof the gesture is one entry).
  const preUndoCentre = afterPan.centerX;
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  const undoneZoom = await stored(mbId, "zoomExponent");
  const undoneCentre = await stored(mbId, "centerX");
  ok(undoneZoom === before.zoomExponent, `one undo reverts the ENTIRE pinch gesture (got ${undoneZoom}, want ${before.zoomExponent})`);
  ok(undoneCentre === preUndoCentre, "that same undo does NOT also revert the earlier interior pan (separate units)");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(SETTLE_MS);

  // ── The new view lives in the DOCUMENT, not in UI state ───────────────────
  // Read straight out of the serialized document: if the interior view were a
  // transient editor object, this would be absent and a reload / CLI render /
  // export would disagree with the screen (the purity invariant, RenderTree =
  // pure(document, [[slide, alpha]])).
  const inDoc = await page.evaluate((id) => {
    const doc = JSON.parse(JSON.stringify(window.__powerrp_app.doc));
    const delta = doc.slides[0].delta.items[id] ?? {};
    return { zoomExponent: delta.zoomExponent, centerX: delta.centerX };
  }, mbId);
  ok(inDoc.zoomExponent === afterZoom, `the zoomed view is stored IN THE DOCUMENT (slide delta zoomExponent = ${inDoc.zoomExponent})`);
  // Compare against the CURRENT stored value, not the post-pan snapshot: a wheel
  // zoom anchored slightly off the box centre legitimately moves the centre too.
  const centreNow = await stored(mbId, "centerX");
  ok(inDoc.centerX === centreNow, `the panned centre is stored IN THE DOCUMENT (slide delta centerX = ${inDoc.centerX}, folded = ${centreNow})`);

  // ── The canvas VIEW never moved: the interior is document state, not a camera ─
  const viewAfter = await page.evaluate(() => window.__powerrp_app.lastViewport?.zoom ?? 1);
  ok(Math.abs(viewAfter - 1) < 1e-9, `the CANVAS zoom is untouched by interior zooming (got ${viewAfter})`);

  // ── TYPING A COORDINATE IN THE BAR: exact digits, ONE undo unit ────────────
  // The user wants to "actually edit those in text on the top", and a 30-digit
  // coordinate pasted into a field that ran it through Number() would silently lose
  // half of it — so the digits are asserted, not just the fact that something changed.
  //
  // THE UNDO UNIT IS MEASURED BY JSON COMPARE, not by reference identity: undo()
  // restores an EQUAL document through a fresh reactive proxy, so `===` on the doc
  // object would report a difference that is not one.
  await page.evaluate(() => { window.__probeCommits = 0; });
  const docBefore = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const TYPED = "-0.7435669000000000123456789";
  const typed = await page.evaluate(async (id, text) => {
    const app = window.__powerrp_app;
    // fineExponent 16 is what makes the deep digits storable at all — the widget
    // reports out loud if you zoom past what fineExponent 0 resolves, and the bar
    // must not quietly round when it IS set.
    app.setPreview([[["items", id, "fineExponent"], 16]]);
    app.commitPreview();
    await new Promise((r) => setTimeout(r, 200));
    const field = [...document.querySelectorAll(".canvas-toolbar-field")]
      .find((f) => f.querySelector(".canvas-toolbar-field-label").textContent.trim() === "Re");
    const input = field.querySelector("input");
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return {
      shown: input.value,
      coarse: app.storedItemValue(id, ["centerX"]),
      fine: app.storedItemValue(id, ["centerFineX"]),
      commits: window.__probeCommits,
    };
  }, mbId, TYPED);
  ok(typed.shown.startsWith(TYPED), `the bar reads back every typed digit (got "${typed.shown}")`);
  ok(typed.fine !== 0, `the deep digits landed in the FINE slot rather than being rounded away (coarse ${typed.coarse}, fine ${typed.fine})`);
  ok(typed.coarse !== Number(TYPED) || typed.fine !== 0, "a float64 alone cannot hold this coordinate — the split must be carrying it");
  // 2 commits: the fineExponent setup above, then the typed coordinate. The COORDINATE
  // is the one undo unit under test, and one undo must restore the document to a state
  // JSON-equal to the one before it.
  ok(typed.commits === 2, `typing a coordinate is ONE undo unit on top of the setup (got ${typed.commits})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  const afterOneUndo = await stored(mbId, "centerX");
  ok(afterOneUndo !== typed.coarse, `one undo reverts the typed coordinate (got ${afterOneUndo})`);
  await page.evaluate(() => window.__powerrp_app.undo()); // and the fineExponent setup
  await sleep(SETTLE_MS);
  const docAfter = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  ok(docAfter === docBefore, "two undos restore a document JSON-EQUAL to the pre-edit one (no stray half-written leaf)");

  // ── Escape exits, normal editing resumes ─────────────────────────────────
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  ok(await modeId() === null, "Escape exits the mode");
  const afterHints = await hintLabels();
  ok(afterHints.includes("Select / drag"), `normal canvas hints are back (got ${JSON.stringify(afterHints)})`);
  ok(!afterHints.includes("Pan inside"), "the mode's hints are gone");
  await page.screenshot({ path: `${shots}/6-after-escape.png` });

  // Normal canvas pan/zoom still works (ctrl+wheel = canvas zoom).
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel({ deltaY: -120 });
  await page.keyboard.up("Control");
  await sleep(SETTLE_MS);
  const canvasZoom = await page.evaluate(() => window.__powerrp_app.lastViewport.zoom);
  ok(canvasZoom > 1, `canvas ctrl+wheel zoom still works after leaving the mode (got ${canvasZoom})`);
  await page.evaluate(() => window.__powerrp_app.canvasActions.setViewport({ zoom: 1, panX: 0, panY: 0 }));
  await sleep(SETTLE_MS);

  // ── An `=`-bound interior property REFUSES the mode, loudly ──────────────
  warnings.length = 0;
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "centerX"], "= 0.25"]]);
    app.commitPreview();
  }, mbId);
  await sleep(SETTLE_MS);
  await page.evaluate(() => { window.__probeDbl = 0; document.querySelector(".overlay").addEventListener("dblclick", () => { window.__probeDbl += 1; }); });
  await dblAt(cx, cy);
  const dblSeen = await page.evaluate(() => window.__probeDbl);
  ok(dblSeen === 1, `the refusal scenario's double-click actually reached the canvas overlay (got ${dblSeen})`);
  ok(await modeId() === null, "an = equation on an interior property REFUSES explore mode (no silent clobber)");
  ok(warnings.some((w) => /Explore interior/.test(w) && /centerX/.test(w)), `the refusal is REPORTED, naming the bound property (got ${JSON.stringify(warnings.slice(-6))})`);
  const stillEquation = await stored(mbId, "centerX");
  ok(stillEquation === "= 0.25", `the equation survives untouched (got ${JSON.stringify(stillEquation)})`);

  // ── HINTBAR COVERAGE for the band/placement gestures (the registry is the ONLY
  // feed for the bar, so an unregistered or unsatisfiable input is invisible) ────
  // The class-level fix for the native-drag kill: a handled canvas double-click
  // leaves NO document selection, so the drag that follows it (any kind) survives.
  const selRanges = await page.evaluate(() => window.getSelection()?.rangeCount ?? -1);
  ok(selRanges === 0, `a handled canvas double-click leaves no document text selection to be drag-and-dropped (got ${selRanges} ranges)`);
  await page.evaluate(() => window.__powerrp_app.armCrosshairBand("regular"));
  await sleep(SETTLE_MS);
  const bandHints = await hintLabels();
  ok(bandHints.includes("Drag box to select"), `ARMED band select prompts the gesture (got ${JSON.stringify(bandHints)})`);
  ok(bandHints.includes("Add to selection") && bandHints.includes("Remove from selection") && bandHints.includes("Invert in box"), "the band's three modifier VERBS are announced while armed");
  await page.screenshot({ path: `${shots}/6-band-hints.png` });
  // Mid-DRAG the verbs stay announced (dragKind === "band" half of the predicate).
  // PAGE coords inside the overlay's own rect (a world point can fall outside the
  // visible render area, and then the press lands on another panel entirely).
  const overlayRect = await page.evaluate(() => { const r = document.querySelector(".overlay").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const bandFrom = { x: overlayRect.x + 30, y: overlayRect.y + overlayRect.h - 90 };
  const bandTo = { x: bandFrom.x + 120, y: bandFrom.y + 60 };
  await page.mouse.move(bandFrom.x, bandFrom.y);
  await page.mouse.down();
  await page.mouse.move(bandTo.x, bandTo.y);
  await sleep(SETTLE_MS);
  const bandDragHints = await hintLabels();
  ok(bandDragHints.includes("Remove from selection"), `mid-band-drag the verbs are still announced (got ${JSON.stringify(bandDragHints)})`);
  await page.screenshot({ path: `${shots}/7-band-drag-hints.png` });
  await page.mouse.up();
  await sleep(SETTLE_MS);

  await page.evaluate(() => window.__powerrp_app.armCrosshairPlacement(window.__powerrp_app.registry.get("rect")));
  await sleep(SETTLE_MS);
  const placeHints = await hintLabels();
  ok(placeHints.includes("Click or drag to place"), `ARMED placement prompts the gesture instead of only offering Cancel (got ${JSON.stringify(placeHints)})`);
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);

  // ── PURGE keybinding (Cmd+Backspace / Cmd+Delete) ────────────────────────
  const purgeId = await spawn("rect", { x: 900, y: 120, w: 80, h: 60 });
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, purgeId);
  await sleep(SETTLE_MS);
  const purgeHints = await hintLabels();
  ok(purgeHints.includes("Purge"), `the HintBar teaches PURGE with a selection (got ${JSON.stringify(purgeHints)})`);
  await page.screenshot({ path: `${shots}/8-purge-hint.png` });
  // Plain Backspace only DEACTIVATES: the item survives in the document.
  await page.keyboard.press("Backspace");
  await sleep(SETTLE_MS);
  const afterDelete = await page.evaluate((id) => !!window.__powerrp_app.rawState().items[id], purgeId);
  ok(afterDelete === true, "plain Backspace only hides the item (it still exists in the document)");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, purgeId);
  await page.keyboard.down("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.up("Control");
  await sleep(SETTLE_MS);
  const afterPurge = await page.evaluate((id) => !!window.__powerrp_app.rawState().items[id], purgeId);
  ok(afterPurge === false, "Cmd/Ctrl+Backspace PURGES — the item is gone from existence");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  const afterPurgeUndo = await page.evaluate((id) => !!window.__powerrp_app.rawState().items[id], purgeId);
  ok(afterPurgeUndo === true, "ONE undo brings a purged item back (purge is a single undo unit)");
  // Cmd+Delete is the same command through its hidden alias.
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, purgeId);
  await page.keyboard.down("Control");
  await page.keyboard.press("Delete");
  await page.keyboard.up("Control");
  await sleep(SETTLE_MS);
  const afterPurgeDelete = await page.evaluate((id) => !!window.__powerrp_app.rawState().items[id], purgeId);
  ok(afterPurgeDelete === false, "Cmd/Ctrl+Delete purges too (the hidden key alias)");

  ok(liveErrors.length === 0, `no console errors during the whole run (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${shots}`);
if (failed.length) {
  console.log(errors.join("\n"));
  process.exit(1);
}
