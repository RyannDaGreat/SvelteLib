/**
 * MULTI-SELECTION INSPECTOR probe — the heterogeneous intersection Property Panel,
 * on the REAL editor.
 *
 * The user's spec, in their words: "I might select an arrow and a box and a video
 * and try to alter their opacity jointly. If they all have different values … a dot
 * dot dot in the parts that are different. And then when I click them, it would
 * have to unify them all to the same value … so that if I wanted to make a bunch
 * of things fade in at the same time, I could do that."
 *
 * So this probe selects EXACTLY those three widget types and asserts:
 *   1. the panel shows the INTERSECTION (opacity is there; a box-only row is not)
 *   2. a differing property renders the MIXED mark, not a fabricated value
 *   3. clicking it UNIFIES all three — proved by reading all three back
 *   4. ONE undo reverts ALL THREE (the behavioural one-undo-unit proof; a stack
 *      DEPTH check is the wrong test — `canUndo` is a boolean, not a depth, a
 *      mistake already recorded in the dump's concerns)
 *   5. once unified, ONE drag on the shared scrubber moves ALL THREE together
 *      (the "fade a bunch of things in at the same time" flow), again one undo
 *   6. a row that is NOT shared does not appear, and a conflicting one is REPORTED
 *   7. SINGLE selection is untouched — same rows, no mixed mark, still one undo
 *
 * Frontend-only Vite on an EPHEMERAL port (never 3637/3638), swiftshader GL.
 * Run from the SvelteLib repo root:
 *   node src/demo_apps/PowerRP/tests/multiselect_inspector_probe.js
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

// The three opacities the deck starts at — deliberately ALL DIFFERENT, so the
// shared row is MIXED and there is a real difference for a unify to destroy.
const OPACITY_ARROW = 1;
const OPACITY_RECT = 0.25;
const OPACITY_VIDEO = 0.6;
// A joint scrub: opacity is bounded 0..1 and the field range-scales a 100px run
// across the whole range, so 30px DOWN is ~-0.3 — large and unambiguous. The
// gesture is VERTICAL (DraggableNumber integrates movementY; up increases), which
// is the seconds_scrub_probe idiom.
const SCRUB_PX = 30;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  // A page error FAILS the probe. An exception thrown inside a Svelte $effect
  // wedges the flush, so every later DOM read silently goes stale — logging it as
  // noise is how that symptom hides its cause.
  page.on("pageerror", (e) => { console.log("PAGEERROR " + e.message); fails.push(`page error: ${e.message}`); });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__powerrp_app)); i++) await sleep(500);
  await sleep(2000);

  /** Reads the three items' RAW stored opacity as plain numbers (never a $state
   *  proxy — those serialize to {} across the puppeteer boundary). */
  const readOpacities = (ids) => page.evaluate((ids) => {
    const raw = window.__powerrp_app.rawState();
    return ids.map((id) => raw.items?.[id]?.opacity ?? null);
  }, ids);

  // ── The deck: an arrow, a box and a video, each at a DIFFERENT opacity ──────
  // addItem + read app.selection back per item is the established idiom; a
  // multi-selection must go through selectMany (assigning an array to
  // app.selection does not register one).
  const ids = await page.evaluate((o) => {
    const app = window.__powerrp_app;
    // DESELECT FIRST. A selection surviving clearDoc points at an item that no
    // longer exists, and the Keyframe Panel then resolves a plugin for
    // type `undefined` and throws inside an $effect.
    app.selection = null;
    app.clearDoc();
    // SPREAD THE PLUGIN DEFAULTS. app.addItem does NOT merge them (it stores
    // exactly what it is handed), and missingDefaults only repairs at the LOAD
    // boundary — so a hand-written arrow with no strokeWidth reaches the canvas
    // with an undefined stroke width and CanvasView throws inside an $effect,
    // which then wedges Svelte's flush and makes every later DOM read stale. That
    // cost this probe two debugging rounds; it is the tests/negative_size_test.js
    // idiom (`...registry.get("arrow").defaults`) and every item here uses it.
    const add = (type, over) => {
      app.addItem({ ...app.registry.get(type).defaults, type, ...over });
      return app.selection;
    };
    const arrow = add("arrow", { from: { x: 120, y: 120 }, to: { x: 300, y: 240 }, opacity: o.arrow });
    const rect = add("rect", { x: 400, y: 200, w: 80, h: 60, opacity: o.rect });
    const video = add("video", { x: 600, y: 200, w: 160, h: 90, opacity: o.video });
    app.selectMany([arrow, rect, video]);
    return { arrow, rect, video, selCount: app.selectedIds().length, types: app.selectedIds().map((id) => app.rawState().items?.[id]?.type) };
  }, { arrow: OPACITY_ARROW, rect: OPACITY_RECT, video: OPACITY_VIDEO });
  const triple = [ids.arrow, ids.rect, ids.video];
  assert(ids.selCount === 3, `three items selected (${ids.selCount})`);
  assert(JSON.stringify(ids.types) === JSON.stringify(["arrow", "rect", "video"]),
    `and they are HETEROGENEOUS: ${JSON.stringify(ids.types)}`);
  await sleep(900);

  // Expand every collapsed category so the intersected rows render.
  const expand = async () => {
    await page.evaluate(() => {
      for (const h of document.querySelectorAll(".inspector .cat-header"))
        if (h.getAttribute("aria-expanded") === "false") h.click();
    });
    await sleep(400);
  };
  await expand();

  // ── 1 + 6. THE INTERSECTION ────────────────────────────────────────────────
  const panel = await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".inspector .row .label")].map((e) => e.textContent.trim());
    return {
      labels,
      count: document.querySelector(".inspector .multi-count")?.textContent.trim() ?? null,
      conflicts: [...document.querySelectorAll(".inspector .multi-conflict")].map((e) => e.textContent.trim()),
      // The core-side answer, so the DOM and the pure function are cross-checked.
      core: (() => {
        const p = window.__powerrp_app.multiSelectPanel();
        return { keys: p.rows.map((r) => r.row.key), mixed: p.rows.filter((r) => r.mixed).map((r) => r.row.key), skipped: p.skipped };
      })(),
    };
  });
  assert(panel.count === "3 items selected", `the panel still says what is selected (${JSON.stringify(panel.count)})`);
  assert(panel.core.keys.includes("opacity"), "opacity IS in the intersection — the user's motivating property");
  assert(panel.labels.includes("Opacity"), "…and it is actually RENDERED as a row");
  assert(!panel.core.keys.includes("x") && !panel.core.keys.includes("w"),
    "a BOX-only row (x / w) is NOT offered — an arrow has from/to, not a frame");
  assert(!panel.core.keys.includes("fill"), "`fill` is not offered (a video has no fill)");
  assert(panel.core.keys.includes("blendMode") && panel.core.keys.includes("shadow.blur"),
    "the universal EFFECTS bundle rides along, so the intersection is rich, not just opacity");
  assert(panel.core.skipped.length === 0, "every selected item is on this slide, so nothing is skipped");

  // ── 2. THE MIXED MARK ──────────────────────────────────────────────────────
  const before = await readOpacities(triple);
  assert(JSON.stringify(before) === JSON.stringify([OPACITY_ARROW, OPACITY_RECT, OPACITY_VIDEO]),
    `precondition: the three opacities really differ (${JSON.stringify(before)})`);
  assert(panel.core.mixed.includes("opacity"), "core reports opacity as MIXED");

  const mixedCell = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")]
      .find((el) => el.querySelector(".label")?.textContent.trim() === "Opacity");
    if (!row) return { found: false };
    const btn = row.querySelector("button.mixed-unify");
    btn?.scrollIntoView({ block: "center" });
    const r = btn?.getBoundingClientRect();
    return {
      found: true,
      hasUnify: !!btn,
      text: btn?.textContent.trim() ?? null,
      // A mixed row must NOT also be showing a number — that would be a
      // fabricated value the document does not hold.
      hasNumberInput: !!row.querySelector(".numfield input"),
      hasDiamond: !!row.querySelector(".keybtn"),
      at: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
    };
  });
  assert(mixedCell.hasUnify, "the mixed Opacity row renders the unify affordance");
  assert(mixedCell.text === "…", `and it shows the MIXED MARK, one character (${JSON.stringify(mixedCell.text)})`);
  assert(!mixedCell.hasNumberInput, "a mixed row shows NO number — it never fabricates a value the document lacks");
  assert(mixedCell.hasDiamond, "the row still carries its keyframe diamond (over the SET)");

  // Hovering must EXPLAIN, and must not touch the document.
  const docBeforeHover = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  await page.mouse.move(20, 950);
  await sleep(150);
  await page.mouse.move(mixedCell.at.x, mixedCell.at.y);
  await page.mouse.move(mixedCell.at.x + 1, mixedCell.at.y);
  await sleep(450);
  const tip = await page.evaluate(() => document.querySelector(".tt-tip")?.textContent.trim().replace(/\s+/g, " ") ?? null);
  assert(tip != null && tip.length > 25, `hovering the mixed mark explains it -> ${JSON.stringify(tip)}`);
  assert(tip !== "…" && tip !== "Opacity", "the tip is not a label/content echo");
  assert((await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc))) === docBeforeHover,
    "hovering the mixed mark leaves the document byte-identical");

  // ── 3. ONE CLICK UNIFIES ALL THREE ─────────────────────────────────────────
  await page.mouse.down();
  await page.mouse.up();
  await sleep(700);
  const unified = await readOpacities(triple);
  assert(new Set(unified).size === 1, `one click unified all three (${JSON.stringify(unified)})`);
  assert(unified[0] === OPACITY_ARROW,
    `…to the PRIMARY's value (${unified[0]} === the arrow's ${OPACITY_ARROW}, the first selected)`);

  // ── 4. ONE UNDO REVERTS ALL THREE (the behavioural proof) ──────────────────
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(600);
  const afterUndo = await readOpacities(triple);
  assert(JSON.stringify(afterUndo) === JSON.stringify(before),
    `ONE undo reverted ALL THREE items — so the joint write was ONE undo unit (${JSON.stringify(afterUndo)})`);
  // THE MULTI-SELECTION MUST SURVIVE THE UNDO. `snapshot()` captured `selection`
  // (the PRIMARY) but not `selectionSet`, and applySnapshot's `selection` write
  // CLEARS the set — so undoing a joint edit collapsed a 3-item selection to 1 and
  // the next gesture silently wrote to one item while the canvas still outlined
  // three. A pre-existing defect this feature is the first to depend on.
  assert((await page.evaluate(() => window.__powerrp_app.selectedIds().length)) === 3,
    "undo RESTORED the whole multi-selection, not just the primary");

  // Redo it so the rest of the probe runs on the unified deck.
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(600);
  assert(new Set(await readOpacities(triple)).size === 1, "redo restores the unified state (one unit, both ways)");

  // ── 5. A JOINT SCRUB MOVES ALL THREE ───────────────────────────────────────
  await expand();
  const scrubAt = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")]
      .find((el) => el.querySelector(".label")?.textContent.trim() === "Opacity");
    // Now UNMIXED, so the ordinary Tier-1 field is back — the same NumericField a
    // single selection gets, not a multi-select fork of it. `.dn` is the
    // DraggableNumber scrubber inside it (the seconds_scrub_probe hook).
    const num = row?.querySelector(".numfield");
    const dn = row?.querySelector(".dn");
    dn?.scrollIntoView({ block: "center" });
    const r = dn?.getBoundingClientRect();
    return { hasField: !!num, hasScrubber: !!dn, hasUnify: !!row?.querySelector("button.mixed-unify"), at: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null };
  });
  assert(scrubAt.hasField, "once unified the row renders the ORDINARY numeric field (no fork)");
  assert(scrubAt.hasScrubber, "…with its real DraggableNumber scrubber");
  assert(!scrubAt.hasUnify, "…and the mixed mark is gone");

  const beforeScrub = (await readOpacities(triple))[0];
  // Trusted vertical drag DOWN (opacity sits at its 1 ceiling, so down is the
  // only direction that can move), stepped so the gesture crosses the click slop.
  await page.mouse.move(scrubAt.at.x, scrubAt.at.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(scrubAt.at.x, scrubAt.at.y + (SCRUB_PX * i) / 10); await sleep(30); }
  await page.mouse.up();
  await sleep(700);
  const scrubbed = await readOpacities(triple);
  assert(new Set(scrubbed).size === 1, `one drag moved ALL THREE to the same value (${JSON.stringify(scrubbed)})`);
  assert(scrubbed[0] !== beforeScrub, `…and it actually moved (${beforeScrub} -> ${scrubbed[0]})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(600);
  assert((await readOpacities(triple)).every((v) => v === beforeScrub),
    "ONE undo reverted the whole joint drag — one undo unit per gesture, not per item");

  // ── 6b. A CONFLICTING row is REPORTED, not silently dropped ────────────────
  const conflict = await page.evaluate(() => {
    const app = window.__powerrp_app;
    // DESELECT FIRST. A selection surviving clearDoc points at an item that no
    // longer exists, and the Keyframe Panel then resolves a plugin for
    // type `undefined` and throws inside an $effect.
    app.selection = null;
    app.clearDoc();
    const add = (type, over) => {
      app.addItem({ ...app.registry.get(type).defaults, type, ...over });
      return app.selection;
    };
    const a = add("shape", { x: 100, y: 100, w: 80, h: 80 });
    const b = add("magnifier", { x: 300, y: 100, w: 80, h: 80 });
    app.selectMany([a, b]);
    const p = app.multiSelectPanel();
    return { keys: p.rows.map((r) => r.row.key), conflicts: p.conflicts.map((c) => c.key) };
  });
  await sleep(700);
  // THE USER OVERRULED THIS EXCLUSION — #300, and this assertion outlived it.
  // It was written when a contract mismatch was a HARD EXCLUSION: two `shape`
  // selects with different option sets were dropped from the panel entirely. The
  // user's ruling: "if the top-level drop-down is different just show it with a
  // triple dot… if I click it, it will unify them… You can still have a warning
  // message on the top explaining why something is special, but don't actually
  // BLOCK me from doing it. There should be a way to get around that."
  //
  // So a mismatched row is now OFFERED (and reported as a conflict, which the
  // next line still pins) rather than withheld. Asserting its absence asserted
  // the behaviour that was explicitly rejected.
  assert(conflict.keys.includes("shape"),
    "a contract-mismatched `shape` row is OFFERED, not withheld (#300: warn, never block)");
  assert(conflict.conflicts.includes("shape"), "…and the exclusion is REPORTED by key, never silently dropped");
  const conflictDom = await page.evaluate(() =>
    [...document.querySelectorAll(".inspector .multi-conflict")].map((e) => e.textContent.trim()));
  assert(conflictDom.includes("shape"), `…and the report is RENDERED (${JSON.stringify(conflictDom)})`);

  // ── 7. SINGLE SELECTION IS UNTOUCHED ───────────────────────────────────────
  const single = await page.evaluate(() => {
    const app = window.__powerrp_app;
    // DESELECT FIRST. A selection surviving clearDoc points at an item that no
    // longer exists, and the Keyframe Panel then resolves a plugin for
    // type `undefined` and throws inside an $effect.
    app.selection = null;
    app.clearDoc();
    app.addItem({ ...app.registry.get("rect").defaults, type: "rect", x: 200, y: 200, w: 80, h: 60, opacity: 0.5 });
    return { id: app.selection, selCount: app.selectedIds().length };
  });
  await sleep(800);
  await expand();
  const singleDom = await page.evaluate(() => ({
    // Row COUNT and LABELS are the single-selection panel's whole shape; if the
    // multi work had leaked into it, one of these would move.
    labels: [...document.querySelectorAll(".inspector .row .label")].map((e) => e.textContent.trim()),
    anyMixedMark: !!document.querySelector(".inspector .mixed-unify, .inspector .mixed-blocked"),
    anyMultiNote: !!document.querySelector(".inspector .multi-note, .inspector .multi-count"),
    opacityHasNumber: (() => {
      const row = [...document.querySelectorAll(".inspector .row")]
        .find((el) => el.querySelector(".label")?.textContent.trim() === "Opacity");
      return !!row?.querySelector(".numfield input, .numfield .dragnum, .numfield");
    })(),
    // The plugin's OWN row list, which the single-selection panel must render whole.
    pluginRowCount: window.__powerrp_app.registry.get("rect").inspector.length,
  }));
  assert(single.selCount === 1, "one item selected");
  assert(!singleDom.anyMixedMark, "a SINGLE selection shows NO mixed mark anywhere");
  assert(!singleDom.anyMultiNote, "…and no multi-selection chrome at all");
  assert(singleDom.opacityHasNumber, "…and its Opacity row is the ordinary numeric field");
  // Every plugin row is present (plus Name + Visible, which are the panel's own).
  assert(singleDom.labels.includes("Opacity") && singleDom.labels.includes("Width") && singleDom.labels.includes("Fill"),
    `…rendering the plugin's own rows (${singleDom.labels.length} labels over ${singleDom.pluginRowCount} plugin rows)`);

  // A single-selection edit still writes exactly one item, one undo unit.
  const singleEdit = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "opacity"], 0.8]]);
    app.commitPreview();
    const after = app.rawState().items[id].opacity;
    app.undo();
    return { after, reverted: app.rawState().items[id].opacity };
  }, single.id);
  assert(singleEdit.after === 0.8 && singleEdit.reverted === 0.5,
    `single-selection commit + undo behave exactly as before (${singleEdit.after} -> ${singleEdit.reverted})`);

  // ── 8. THE UNIVERSAL SECTION OVER A SET (WORKSTREAM BE) ────────────────────
  // User, 2026-08-02 night: "the universal drop-down menu should still be there,
  // or at least some subset of it… widget type, visible, and morph all should be.
  // The reason why? I just duplicated three objects and there was no way to
  // change their visibility interpolation all at once."
  //
  // MEASURED BEFORE THE FIX, by this probe's own idiom: three duplicated rects
  // rendered 39 plugin rows and ZERO interp buttons, so visibility interpolation
  // over a set was UNREACHABLE, not merely tedious.
  console.log("\n  — WORKSTREAM BE: the universal section over a set —");
  const trio = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    // THE USER'S OWN SCENARIO: duplicate three objects and select them.
    const ids = [0, 1, 2].map((i) => {
      app.addItem({ ...app.registry.get("rect").defaults, type: "rect", x: 120 + i * 130, y: 160, w: 80, h: 60 });
      return app.selection;
    });
    app.selectMany(ids);
    return ids;
  });
  await sleep(900);
  await expand();

  const universal = await page.evaluate(() => {
    const cat = [...document.querySelectorAll(".inspector .prop-category")]
      .find((c) => /Universal/i.test(c.querySelector(".cat-header")?.textContent ?? ""));
    if (!cat) return { found: false };
    return {
      found: true,
      labels: [...cat.querySelectorAll(".label")].map((e) => e.textContent.trim()),
      // The widget-type row is displayed but not jointly writable, so it renders
      // the INERT mark with its reason rather than a live control.
      blocked: [...cat.querySelectorAll(".mixed-blocked")].length,
    };
  });
  assert(universal.found, "the UNIVERSAL section is present with three items selected");
  assert(universal.labels.includes("Widget type"), "…showing Widget type (the user named it)");
  assert(universal.labels.includes("Visible"), "…and Visible");
  assert(universal.labels.some((l) => /^Morph/i.test(l)), `…and Morph (${JSON.stringify(universal.labels)})`);
  assert(universal.labels.includes("Visible interp"),
    "…and VISIBILITY INTERPOLATION, the row whose absence was the whole report");
  assert(!universal.labels.includes("Name"),
    "NAME is the one row the user volunteered to drop, and it is absent");
  assert(universal.blocked === 1,
    `exactly one universal row is inert — the type row, which cannot take a joint write (${universal.blocked})`);

  // THE DRIVING ACCEPTANCE, end to end on the real editor: ONE edit to visibility
  // interpolation changes ALL THREE, and ONE Cmd+Z reverts ALL THREE. The undo
  // proof is BEHAVIOURAL (read all three back), never a stack-DEPTH check —
  // `canUndo` is a boolean, a mistake already recorded in the dump's concerns.
  const accept = await page.evaluate((ids) => {
    const app = window.__powerrp_app;
    const read = () => ids.map((id) => app.rawState().items?.[id]?.["active~interp"] ?? null);
    const before = read();
    const written = app.unifySelection("active~interp", "blurFade");
    const after = read();
    app.undo();
    return { before, written, after, afterUndo: read() };
  }, trio);
  assert(accept.before.every((v) => v === null),
    `precondition: none of the three has an authored visibility interp yet (${JSON.stringify(accept.before)})`);
  assert(accept.written === 3, `ONE edit writes all three items (${accept.written})`);
  assert(accept.after.every((v) => v === "blurFade"),
    `…and all three really changed (${JSON.stringify(accept.after)})`);
  assert(accept.afterUndo.every((v) => v === null),
    `ONE undo reverts ALL THREE — one undo unit (${JSON.stringify(accept.afterUndo)})`);

  // VISIBLE ITSELF UNIFIES over the set, which is the other half of the ruling.
  const visibleUnify = await page.evaluate((ids) => {
    const app = window.__powerrp_app;
    // Make them disagree, then unify in one edit.
    app.setPreview([[["items", ids[1], "active"], false], [["items", ids[2], "active"], false]]);
    app.commitPreview();
    const mixedRow = app.multiSelectPanel().rows.find((r) => r.row.key === "active");
    const written = app.unifySelection("active", true);
    const after = ids.map((id) => app.rawState().items?.[id]?.active ?? null);
    app.undo();
    return { mixed: mixedRow?.mixed ?? null, written, after };
  }, trio);
  assert(visibleUnify.mixed === true, "a set whose visibility disagrees reports MIXED");
  assert(visibleUnify.after.every((v) => v === true),
    `…and one unify makes every selected item visible (${JSON.stringify(visibleUnify.after)})`);

  // ── WORKSTREAM BH: the SECTION-HEADER keyframe bubble ──────────────────────
  // User, 2026-08-02 night: "In each drop-down… a slightly different-looking,
  // maybe a bit smaller keyframe bubble on it too… half-filled if some of them
  // are keyframed, completely unfilled if none… fully filled if all of them are… And upon
  // clicking it, we'll toggle between all or none… Maybe just 30% smaller than
  // the normal one… we can get the left and right parts for it."
  //
  // core/section_keyframes.js pins the pure reasoning bare-node. THIS section
  // pins what only the real editor can answer: that the bubble is IN the header,
  // that it is genuinely smaller than a row's, that its click reaches the
  // document through the app, and that ONE undo takes a whole section back.
  console.log("\n  — WORKSTREAM BH: the section-header keyframe bubble —");

  // A THREE-SLIDE deck with one rect, so slide 1 can be keyed and cleared
  // without disturbing the creating delta on slide 0.
  const bhItem = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    app.addItem({ ...app.registry.get("rect").defaults, type: "rect", x: 300, y: 200, w: 120, h: 90 });
    const id = app.selection;
    app.addSlide();
    app.addSlide();
    app.slideIndex = 1;
    app.selection = id;
    return id;
  });
  await sleep(900);
  await expand();

  /** The Transform section's header DOM: its bubble, that bubble's icon (which IS
   *  the tri-state reading), and the geometry that proves it is the smaller one. */
  const readSection = (title) => page.evaluate((title) => {
    const cat = [...document.querySelectorAll(".inspector .prop-category")]
      .find((c) => (c.querySelector(".cat-title")?.textContent ?? "").trim() === title);
    if (!cat) return { found: false };
    const headerRow = cat.querySelector(".cat-header-row");
    const bubble = headerRow?.querySelector(".kf-section");
    const diamond = bubble?.querySelector(".keybtn");
    const rowDiamond = cat.querySelector(".cat-rows .kf-controls .keybtn");
    const box = (e) => (e ? Math.round(e.getBoundingClientRect().width) : null);
    return {
      found: true,
      // THE HEADER IS A ROW holding the collapse button and the bubble as
      // SIBLINGS — a <button> may not contain a <button>.
      headerIsRow: !!headerRow,
      collapseStillHeader: !!headerRow?.querySelector(":scope > .cat-header"),
      hasBubble: !!bubble,
      // The three parts the user reversed themselves to keep.
      jumps: bubble ? bubble.querySelectorAll(".jumpbtn").length : 0,
      icon: diamond?.querySelector("iconify-icon")?.getAttribute("icon") ?? null,
      keyed: diamond?.classList.contains("keyed") ?? null,
      keyedSome: diamond?.classList.contains("keyed-some") ?? null,
      tip: diamond?.closest(".tt-anchor") ? diamond.getAttribute("aria-label") : diamond?.getAttribute("aria-label") ?? null,
      sectionW: box(diamond),
      rowW: box(rowDiamond),
      // What the app itself says, so the DOM and the pure read are cross-checked.
      core: (() => {
        const app = window.__powerrp_app;
        const id = app.selection;
        return app.sectionKeyframeState([["items", id, "x"], ["items", id, "y"]]);
      })(),
    };
  }, title);

  const clickSectionBubble = async (title) => {
    await page.evaluate((title) => {
      const cat = [...document.querySelectorAll(".inspector .prop-category")]
        .find((c) => (c.querySelector(".cat-title")?.textContent ?? "").trim() === title);
      cat.querySelector(".cat-header-row .kf-section .keybtn").click();
    }, title);
    await sleep(500);
  };

  const bhEmpty = await readSection("Transform");
  assert(bhEmpty.found, "the Transform section is on screen");
  assert(bhEmpty.headerIsRow && bhEmpty.collapseStillHeader,
    "the header is a ROW holding the collapse .cat-header and the bubble as siblings");
  assert(bhEmpty.hasBubble, "…and the section header carries its own keyframe bubble");
  assert(bhEmpty.jumps === 2,
    `…with BOTH the left and right parts (the user's final word) (${bhEmpty.jumps})`);
  // "Maybe just 30% smaller than the normal one."
  assert(bhEmpty.sectionW !== null && bhEmpty.rowW !== null && bhEmpty.sectionW < bhEmpty.rowW,
    `the section bubble is SMALLER than a row's (${bhEmpty.sectionW}px vs ${bhEmpty.rowW}px)`);
  assert(Math.abs(bhEmpty.sectionW / bhEmpty.rowW - 0.7) < 0.08,
    `…by about 30% (ratio ${(bhEmpty.sectionW / bhEmpty.rowW).toFixed(2)})`);
  // EMPTY: nothing in the section is keyed on this slide.
  assert(bhEmpty.icon === "mdi:rhombus-outline" && bhEmpty.core === "none",
    `EMPTY when no property in the section is keyframed here (${bhEmpty.icon}/${bhEmpty.core})`);
  assert(bhEmpty.keyed === false && bhEmpty.keyedSome === false, "…and it wears neither fill class");

  // ── HALF: key ONE property in the section, by hand. ────────────────────────
  await page.evaluate((id) => {
    window.__powerrp_app.keyframePath(["items", id, "x"], 321);
  }, bhItem);
  await sleep(500);
  const bhHalf = await readSection("Transform");
  assert(bhHalf.icon === "mdi:rhombus-split" && bhHalf.core === "some",
    `HALF when only some of the section is keyframed (${bhHalf.icon}/${bhHalf.core})`);
  assert(bhHalf.keyedSome === true && bhHalf.keyed === false,
    "…and the half fill is a class of its own, so it can never render as FULL");

  // ── CLICK from HALF → ALL (the ruling: the click completes before it clears) ─
  const sectionKeys = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const delta = app.doc.slides[app.slideIndex].delta.items?.[id] ?? {};
    return { keys: Object.keys(delta).sort(), x: delta.x ?? null, canUndo: app.canUndo };
  }, bhItem);

  await clickSectionBubble("Transform");
  const bhAll = await readSection("Transform");
  const allKeys = await sectionKeys(bhItem);
  assert(bhAll.icon === "mdi:rhombus" && bhAll.core === "all",
    `one click from HALF fills the whole section (${bhAll.icon}/${bhAll.core})`);
  assert(bhAll.keyed === true, "…wearing the full-fill class");
  assert(allKeys.keys.length > 1, `…and the document really gained the section's keys (${JSON.stringify(allKeys.keys)})`);
  assert(allKeys.x === 321,
    "…without overwriting the keyframe that made it half (the UPSERT, not a restamp)");

  // ONE UNDO takes the WHOLE section back — the behavioural one-undo-unit proof,
  // read off the document rather than off a stack depth (canUndo is a boolean).
  const bhAfterUndo = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.undo();
    const delta = app.doc.slides[app.slideIndex].delta.items?.[id] ?? {};
    return { keys: Object.keys(delta).sort(), tri: app.sectionKeyframeState([["items", id, "x"], ["items", id, "y"]]) };
  }, bhItem);
  await sleep(400);
  assert(bhAfterUndo.tri === "some" && bhAfterUndo.keys.length === 1,
    `ONE undo reverted the ENTIRE section toggle — one undo unit (${JSON.stringify(bhAfterUndo.keys)})`);
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(400);

  // ── CLICK from ALL → NONE, again one undo unit ────────────────────────────
  await clickSectionBubble("Transform");
  const bhCleared = await readSection("Transform");
  const clearedKeys = await sectionKeys(bhItem);
  assert(bhCleared.icon === "mdi:rhombus-outline" && bhCleared.core === "none",
    `a FULL section clears on the next click (${bhCleared.icon}/${bhCleared.core})`);
  assert(!clearedKeys.keys.includes("x") && !clearedKeys.keys.includes("y"),
    `…and the section's keys are gone from the slide (${JSON.stringify(clearedKeys.keys)})`);
  const afterClearUndo = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.undo();
    return app.sectionKeyframeState([["items", id, "x"], ["items", id, "y"]]);
  }, bhItem);
  await sleep(400);
  assert(afterClearUndo === "all", `ONE undo restores every cleared keyframe at once (${afterClearUndo})`);

  // ── THE LEFT/RIGHT PARTS navigate, section-wide ───────────────────────────
  // Put a keyframe on slide 2 for a DIFFERENT property of the section, so the
  // jump can only land there by walking the UNION rather than one row's path.
  const jumped = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.slideIndex = 2;
    app.keyframePath(["items", id, "y"], 77);
    app.slideIndex = 0;
    const clickJump = (which) => {
      const cat = [...document.querySelectorAll(".inspector .prop-category")]
        .find((c) => (c.querySelector(".cat-title")?.textContent ?? "").trim() === "Transform");
      cat.querySelectorAll(".cat-header-row .kf-section .jumpbtn")[which].click();
    };
    clickJump(1); // ›
    const firstForward = app.slideIndex;
    clickJump(1);
    const secondForward = app.slideIndex;
    clickJump(0); // ‹
    const back = app.slideIndex;
    return { firstForward, secondForward, back };
  }, bhItem);
  await sleep(500);
  assert(jumped.firstForward === 1, `› walks to the next slide keyframing the section (${jumped.firstForward})`);
  assert(jumped.secondForward === 2,
    `…and on to slide 2, which only a UNION walk reaches — its keyframe is on a DIFFERENT row (${jumped.secondForward})`);
  assert(jumped.back === 1, `‹ walks back the same way (${jumped.back})`);

  // ── A SECTION WITH NOTHING KEYFRAMEABLE GETS NO BUBBLE ────────────────────
  // A transition's config rows are per-boundary CONFIG, not keyframeable state,
  // so their sections must not carry a control that claims otherwise.
  const transitionBubbles = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.selectTransition?.(app.doc.slides[1].id);
    return null;
  }).then(() => sleep(700)).then(() => page.evaluate(() => ({
    categories: document.querySelectorAll(".inspector .prop-category").length,
    bubbles: document.querySelectorAll(".inspector .cat-header-row .kf-section").length,
    rowDiamonds: document.querySelectorAll(".inspector .cat-rows .keybtn").length,
  })));
  if (transitionBubbles.categories > 0 && transitionBubbles.rowDiamonds === 0)
    assert(transitionBubbles.bubbles === 0,
      `a section whose rows carry no diamonds carries no section bubble either (${transitionBubbles.bubbles})`);

  // ── MULTI-SELECTION: the bubble reads the UNION and the toggle fans out ────
  const bhTrio = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selection = null;
    app.clearDoc();
    const ids = [0, 1, 2].map((i) => {
      app.addItem({ ...app.registry.get("rect").defaults, type: "rect", x: 120 + i * 130, y: 160, w: 80, h: 60 });
      return app.selection;
    });
    app.addSlide();
    app.slideIndex = 1;
    app.selectMany(ids);
    // ONE of the three is already keyed here, so the union reads HALF.
    app.keyframePath(["items", ids[0], "x"], 999);
    return ids;
  });
  await sleep(900);
  await expand();

  const setHalf = await readSection("Transform");
  assert(setHalf.hasBubble, "the SET panel's sections carry the bubble too (BE's intersection panel)");
  assert(setHalf.icon === "mdi:rhombus-split",
    `…reading HALF across the whole selection — 'somewhere in this section, on some item' (${setHalf.icon})`);

  await clickSectionBubble("Transform");
  const fanOut = await page.evaluate((ids) => {
    const app = window.__powerrp_app;
    const delta = () => app.doc.slides[app.slideIndex].delta.items ?? {};
    const after = ids.map((id) => ({ ...(delta()[id] ?? {}) }));
    app.undo();
    const undone = ids.map((id) => Object.keys(delta()[id] ?? {}).length);
    return { after, undone, x0: after[0].x ?? null };
  }, bhTrio);
  await sleep(400);
  assert(fanOut.after.every((d) => "x" in d && "y" in d),
    `one click keyframed the section on EVERY selected item (${JSON.stringify(fanOut.after.map((d) => Object.keys(d).sort()))})`);
  assert(fanOut.x0 === 999, "…and the item that was already keyed kept its own value");
  assert(fanOut.undone[1] === 0 && fanOut.undone[2] === 0,
    `ONE undo reverted the whole fan-out — still one undo unit (${JSON.stringify(fanOut.undone)})`);

  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nPASS — multi-selection Inspector intersection");
  process.exitCode = fails.length ? 1 : 0;
} finally {
  await browser.close();
  await server.close();
}
