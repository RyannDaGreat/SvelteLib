/**
 * THE EDITOR'S OFF-SCREEN COST (R7-6) — measured, then pinned.
 *
 * ── WHAT THE USER SAW AND WHAT IS ACTUALLY WRONG ────────────────────────────
 * "The canvas should cull objects in the editor too. Why isn't it doing that
 * already??? It's laggy when there are tons of objects, even if they're out of
 * view." The first half is FALSE — the paint has culled since core/view.canSkipNode
 * existed (web/CanvasView.svelte's paint filters on it) — and the second half is
 * TRUE. The cost is in the two places culling never reached:
 *
 *   1. `app.nodes()` was an UN-MEMOIZED full deriveRenderTree over every item,
 *      called ~28 times per frame from CanvasView alone (several from
 *      pointermove handlers and from $derived blocks that depend on `viewport`).
 *   2. The node overlay emitted one SVG <circle> per PORT of every node in the
 *      document, un-culled, rebuilt on every viewport change.
 *
 * So this probe measures BOTH, on a synthetic deck of NODE_COUNT nodes parked far
 * off-view — the shape of the user's report — and asserts the contract that fixes
 * it. Every number it asserts is also PRINTED, so a regression that halves the
 * win but stays inside the bound is still visible in the log.
 *
 * ── HOW THE DERIVE COUNT IS MEASURED, AND WHY BY IDENTITY ───────────────────
 * `app.nodes` is wrapped and the returned array's IDENTITY is compared with the
 * previous one. A memo hit returns the SAME array; a miss returns a fresh one. So
 * "distinct arrays seen in one frame" IS the number of full derivations that
 * frame, with no counter inside production code and no guess about which call
 * sites ran. It counts every consumer that goes through `app.nodes()`, which
 * after this round includes paint() itself.
 *
 * ── WHY node_math AND NOT AN AUDIO NODE ─────────────────────────────────────
 * Three ports each and no engine: a thousand audio modules would build a thousand
 * real WebAudio nodes on commit and the probe would be measuring the synth.
 *
 * Run alone (warms the Vite dep cache — see CLAUDE.md's cold-cache warning):
 *   node src/demo_apps/PowerRP/tests/canvas_cull_perf_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
/** Vite's root is `web/`, so a module outside it is served at `/@fs/<abs path>` —
 *  the same URL the app's own `../core/…` import resolves to, hence the same module
 *  instance. Used to count what the UN-CULLED lists WOULD have held, measured from
 *  the very functions the overlay calls rather than asserted from arithmetic. */
const fsUrl = (rel) => `/@fs${resolve(repo, "src/demo_apps/PowerRP", rel)}`;

/** "Tons of objects" from the user's report, at the scale he described. Big
 *  enough that an un-culled overlay is thousands of DOM nodes and a per-call
 *  re-derivation is tens of milliseconds; small enough to commit in one go. */
const NODE_COUNT = 1000;
/** Ports per node_math (a, b, out) — the bead multiplier. */
const PORTS_PER_NODE = 3;
/** World X of the off-view patch. The camera is 1280 wide at the origin and the
 *  probe never zooms out, so this is unreachable from the default view by any
 *  amount of the 1 px nudges below. */
const OFFSCREEN_X = 200000;
/** The off-view patch's grid pitch, in world units — wider than a node's default
 *  card so no two overlap (overlapping cards would still cull identically, but a
 *  measurement should not depend on that). */
const PATCH_PITCH = 300;
const PATCH_COLUMNS = 40;
/** Two nodes left ON view, wired together. They are the control: culling that
 *  also removes what you are looking at is not culling, it is a blank canvas. */
const VISIBLE_NODE_COUNT = 2;
/** Frames driven for the timing figure. Enough that per-frame noise averages out,
 *  short enough that the whole probe stays well inside the suite's cap. */
const PAN_FRAMES = 30;
/** Pointer moves driven for the hover figure. A move changes NO document state, so
 *  every derivation it causes is pure waste — which is what makes it the sharpest
 *  test of the memo, and the gesture the "~28 calls per frame" grep was about. */
const HOVER_MOVES = 20;

/** The bound the memo must hold over a whole gesture: the evaluated state does not
 *  change while panning or hovering, so ONE derivation covers all of it. Two is
 *  allowed for the frame the gesture starts on (a commit or an async raster landing
 *  alongside it is not a defect); tens are. */
const MAX_DERIVES_PER_GESTURE = 2;
/** The bound on beads emitted for a document whose nodes are ALL off-view. Zero
 *  is the true answer; the allowance is for a node the cull margin keeps. */
const MAX_OFFSCREEN_BEADS = 0;

// HMR OFF: in a worktree with other agents editing, a source save mid-run reloads
// the page and destroys the session being measured (tests/audio_frame_seam_probe.js
// records the same measurement).
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const liveErrors = [];
  page.on("pageerror", (e) => liveErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (isWebGpuAbsenceNoise(m.text())) return;
    if (/\/api\/projects|500 \(Internal Server Error\)/.test(m.text())) return; // no project backend when run alone
    liveErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  // 120 s for the reason tests/audio_frame_seam_probe.js records: with several
  // agents' Vite servers on one host the dep optimizer keeps the network busy well
  // past the app being interactive, and a tighter timeout reports a loaded HOST as
  // a broken app.
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });

  // ── BUILD THE DECK: a big off-view patch plus a small on-view control ──────
  const built = await page.evaluate((count, offX, pitch, columns, visible) => {
    const app = window.__powerrp_app;
    const defaults = app.registry.get("node_math").defaults;
    const items = {};
    for (let i = 0; i < count; i += 1)
      items[`perf_${i}`] = { ...structuredClone(defaults), x: offX + (i % columns) * pitch, y: Math.floor(i / columns) * pitch };
    // The control pair sits inside the camera rect and is WIRED, so the wire
    // assertions below have something real to look at.
    for (let i = 0; i < visible; i += 1)
      items[`seen_${i}`] = { ...structuredClone(defaults), x: 120 + i * pitch, y: 200 };
    items.seen_1.inputs = { ...items.seen_1.inputs, a: { item: "seen_0", port: "out" } };
    const doc = {
      ...app.doc,
      slides: app.doc.slides.map((s, i) => i === 0 ? { ...s, delta: { ...s.delta, items: { ...s.delta.items, ...items } } } : s),
    };
    app.commit(app.repaired(doc));
    return { items: Object.keys(app.state().items).length };
  }, NODE_COUNT, OFFSCREEN_X, PATCH_PITCH, PATCH_COLUMNS, VISIBLE_NODE_COUNT);
  await new Promise((r) => setTimeout(r, 1500));

  ok(built.items >= NODE_COUNT + VISIBLE_NODE_COUNT,
    `the synthetic deck committed (${built.items} items folded)`);

  // ── 1. THE OVERLAY IS CULLED ──────────────────────────────────────────────
  // First, what the un-culled lists HELD — read from the same two functions the
  // overlay layers call, so the "before" figure is measured on this deck rather
  // than multiplied out on paper.
  const unculled = await page.evaluate(async (beadsUrl, anchorsUrl) => {
    const { allPortBeads } = await import(beadsUrl);
    const { nodeAnchors } = await import(anchorsUrl);
    const nodes = window.__powerrp_app.nodes();
    return {
      beads: allPortBeads(nodes).length,
      anchors: nodes.reduce((sum, n) => sum + nodeAnchors(n).length, 0),
    };
  }, fsUrl("core/wire_drag.js"), fsUrl("core/derive.js"));

  const beadsAtHome = await page.evaluate(() => document.querySelectorAll("circle.nf-bead").length);
  ok(beadsAtHome === VISIBLE_NODE_COUNT * PORTS_PER_NODE,
    `only the ON-VIEW nodes get beads: ${beadsAtHome} (expected ${VISIBLE_NODE_COUNT * PORTS_PER_NODE}; the un-culled list holds ${unculled.beads})`);

  // Pan so that EVERYTHING is off-view — including the control pair. Nothing is
  // visible, so nothing may be in the DOM.
  const beadsAway = await page.evaluate(async () => {
    window.__powerrp_app.canvasActions.setViewport({ zoom: 1, panX: -50000, panY: -50000 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelectorAll("circle.nf-bead").length;
  });
  ok(beadsAway <= MAX_OFFSCREEN_BEADS,
    `with the whole document off-view the overlay emits ${beadsAway} beads (bound ${MAX_OFFSCREEN_BEADS})`);

  // And back: culling that does not restore is just deletion.
  const beadsBack = await page.evaluate(async () => {
    window.__powerrp_app.canvasActions.setViewport({ zoom: 1, panX: 0, panY: 0 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelectorAll("circle.nf-bead").length;
  });
  ok(beadsBack === VISIBLE_NODE_COUNT * PORTS_PER_NODE,
    `panning back restores exactly the on-view beads (${beadsBack})`);

  // THE ANCHOR CROSSES ARE THE SAME DEFECT, ONE OVERLAY LAYER OVER, and worse per
  // node: `overlay` emitted one <g class="anchor"> per ANCHOR of every node in the
  // document whenever "show anchors" is on. Nine per node_math here.
  const anchorMarks = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.anchorsVisible = true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const onView = document.querySelectorAll("g.anchor").length;
    app.canvasActions.setViewport({ zoom: 1, panX: -50000, panY: -50000 });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const offView = document.querySelectorAll("g.anchor").length;
    app.canvasActions.setViewport({ zoom: 1, panX: 0, panY: 0 });
    app.anchorsVisible = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { onView, offView };
  });
  ok(anchorMarks.onView > 0 && anchorMarks.offView === 0,
    `anchor crosses are culled too: ${anchorMarks.onView} with the control on view, ${anchorMarks.offView} with the document off it (the un-culled list holds ${unculled.anchors})`);

  // ── 2. THE MEMO: ONE DERIVATION PER FRAME, AND IT STILL INVALIDATES ────────
  const perf = await page.evaluate(async (frames, hoverMoves) => {
    const app = window.__powerrp_app;
    const original = app.nodes.bind(app);
    let last = null;
    let distinct = 0;
    let calls = 0;
    app.nodes = () => {
      const r = original();
      calls += 1;
      if (r !== last) { distinct += 1; last = r; }
      return r;
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // A 1 px pan per frame: the cheapest change that invalidates every
    // viewport-dependent $derived and forces a repaint, i.e. the frame an author
    // pays for while dragging the canvas.
    await frame();
    const t0 = performance.now();
    const perFrame = [];
    for (let i = 0; i < frames; i += 1) {
      const before = distinct;
      const beforeCalls = calls;
      app.canvasActions.setViewport({ zoom: 1, panX: -i, panY: 0 });
      await frame();
      perFrame.push({ derives: distinct - before, calls: calls - beforeCalls });
    }
    const elapsed = performance.now() - t0;

    // ── HOVER: a pointer move over the canvas, which changes no state at all ──
    // Dispatched on the SVG overlay because that is the element CanvasView binds
    // its pointer handlers to; a synthetic PointerEvent runs the same handlers a
    // real move does (nothing on this path checks isTrusted).
    const svg = document.querySelector("svg.overlay");
    const box = svg.getBoundingClientRect();
    const hoverStart = { derives: distinct, calls };
    const hoverT0 = performance.now();
    for (let i = 0; i < hoverMoves; i += 1) {
      svg.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, pointerType: "mouse",
        clientX: box.x + box.width / 2 + i, clientY: box.y + box.height / 2,
      }));
      await frame();
    }
    const hover = {
      derives: distinct - hoverStart.derives,
      calls: calls - hoverStart.calls,
      elapsed: performance.now() - hoverT0,
    };

    // INVALIDATION, both axes that matter for a memo keyed on the evaluation:
    // an unchanged document must return the SAME array, and an EDIT must not.
    const a = app.nodes();
    const b = app.nodes();
    app.setPreview([[["items", "seen_0", "x"], 999]]);
    const c = app.nodes();
    app.commitPreview();
    const d = app.nodes();
    // THE AXIS NO ARGUMENT CAN SEE: an asset ref's RESOLUTION changes with the
    // blob-URL memo, not with the document (see nodes()). Bumping the library
    // counter must re-derive, or a static deck whose assets prime after the first
    // paint shows every one of them as missing for the rest of the session.
    app.assetsVersion += 1;
    const e = app.nodes();

    app.nodes = original;
    return {
      elapsed,
      frames: perFrame,
      hover,
      stable: a === b,
      previewInvalidates: c !== b,
      commitInvalidates: d !== c,
      assetsInvalidate: e !== d,
      movedTo: app.state().items.seen_0.x,
    };
  }, PAN_FRAMES, HOVER_MOVES);

  const panDerives = perf.frames.reduce((s, f) => s + f.derives, 0);
  const panCalls = perf.frames.reduce((s, f) => s + f.calls, 0);
  const msPerFrame = perf.elapsed / PAN_FRAMES;

  console.log(`\n── MEASURED, ${NODE_COUNT} off-view nodes + ${VISIBLE_NODE_COUNT} on-view ──`);
  console.log(`  PAN, ${PAN_FRAMES} frames:  app.nodes() calls ${panCalls}, full derivations ${panDerives}`);
  // THE WALL FIGURES HAVE A FLOOR and it must be stated or they will be misread:
  // each iteration awaits TWO rAFs (the second is what guarantees the paint effect
  // ran), so ~33 ms/frame at 60 Hz is the harness, not the app. A number sitting on
  // that floor means the work is no longer measurable this way — it is an upper
  // bound on the cost, and any speedup computed against it is a LOWER bound.
  console.log(`               wall ${perf.elapsed.toFixed(0)} ms (${msPerFrame.toFixed(1)} ms/frame; harness floor ≈ 33 ms = 2 rAF)`);
  console.log(`  HOVER, ${HOVER_MOVES} moves: app.nodes() calls ${perf.hover.calls}, full derivations ${perf.hover.derives}`);
  console.log(`               wall ${perf.hover.elapsed.toFixed(0)} ms (${(perf.hover.elapsed / HOVER_MOVES).toFixed(1)} ms/move)`);
  console.log(`  beads   in the DOM: ${beadsAway} off-view / ${beadsAtHome} with the control on view / ${unculled.beads} un-culled`);
  console.log(`  anchors in the DOM: ${anchorMarks.offView} off-view / ${anchorMarks.onView} with the control on view / ${unculled.anchors} un-culled\n`);

  ok(panDerives <= MAX_DERIVES_PER_GESTURE,
    `panning ${PAN_FRAMES} frames costs at most ${MAX_DERIVES_PER_GESTURE} derivations (was ${panDerives}, from ${panCalls} calls)`);
  ok(perf.hover.derives <= MAX_DERIVES_PER_GESTURE,
    `hovering ${HOVER_MOVES} moves costs at most ${MAX_DERIVES_PER_GESTURE} derivations (was ${perf.hover.derives}, from ${perf.hover.calls} calls)`);
  ok(perf.stable, "two app.nodes() calls with nothing changed return the SAME array (the memo hits)");
  ok(perf.previewInvalidates, "a live preview re-derives (the memo must not outlive a mid-gesture edit)");
  ok(perf.commitInvalidates, "committing the preview re-derives again");
  ok(perf.assetsInvalidate, "an asset-library change re-derives (a ref's RESOLUTION is not in the document)");
  ok(perf.movedTo === 999, `and the edit really landed (seen_0.x = ${perf.movedTo})`);

  ok(liveErrors.length === 0, `no page errors (${liveErrors.join(" | ")})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} failure(s)`);
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed`);
