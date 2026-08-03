/**
 * SLIDE GRID probe — the navigator's SECOND layout, and the Asset Explorer's.
 *
 * WHAT PROBLEM THE GRID SOLVES, because every assertion here is downstream of it
 * (user, 2026-08-02, verbatim): "Sometimes, if I want to view many slides, I try
 * to make the slides panel bigger. But here's what happens. The slides just become
 * enormous. It would be nice if there was a second option for viewing slides. That
 * would make it a tiled thumbnail display exactly how the asset explorer panel is
 * working… You can have the same thing for the asset explorer too. You do need to
 * be careful with the logic though about dragging slides."
 *
 *   node src/demo_apps/PowerRP/tests/slide_grid_probe.js
 *
 * WHY A PROBE. Everything here is LAYOUT — how many columns, which edge a pill
 * straddles, whether two mid-drag tiles intersect — and layout is precisely what
 * bare node cannot see. The reorder MATH is already pinned in node
 * (tests/slide_reorder_test.js proves the appearance law for every permutation),
 * so this probe deliberately does not re-prove it; it proves the grid's gestures
 * reach it.
 *
 * NO SCREENSHOTS, for the reason slide_strip_probe.js states: 64 browser probes
 * call page.screenshot, and on a host whose capture path hangs each one burns its
 * full protocol timeout and dies with a stack that reads like an app regression
 * (CLAUDE.md's browser_capture_preflight note). Every claim below is assertable
 * from page.evaluate, so there is no reason to take that risk.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const demoJson = await readFile(resolve(webRoot, "../examples/demo.powerrp.json"), "utf8");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
/** Command (throws). The probe's one assertion helper. */
function check(ok, message) {
  if (!ok) throw new Error(message);
}

// Long enough to outlast the tiles' 0.3s FLIP (SlideNav's DRAG_SHIFT_MS) before
// the tiling is measured — reading mid-easing measures the animation, not the
// layout. Same constant and same reason as the strip probe's.
const DRAG_SHIFT_SETTLE_MS = 600;

try {
  const page = await browser.newPage();
  // WIDE ENOUGH FOR MORE THAN ONE COLUMN, which is the whole point of the view:
  // a one-column grid would pass a "the toggle switched the layout" check while
  // proving nothing about the thing the user asked for, and the row-major drag
  // math has no wrap to get wrong.
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  // The boot-noise exclusions every rail/nav probe carries — a headless paint
  // race in CanvasView, SwiftShader having no WebGPU adapter, and the project-API
  // 500/ECONNREFUSED a probe sees when no BACKEND_URL points at a running server.
  const ignore = (t) => /zero-sized canvas|VideoV7: WebGPU init failed|Failed to load resource|\/api\/|listAssets|500 \(Internal Server Error\)|ECONNREFUSED/i.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".slidenav [data-slide-row]");

  /** Command. Clicks the rail's view toggle and waits for Svelte to flush. */
  const toggleView = () => page.evaluate(async () => {
    document.querySelector(".slidenav .nav-actions [data-nav-view]").click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

  // ── 0. LIST VIEW IS UNTOUCHED BY THIS WORKSTREAM ───────────────────────────
  // A GUARD ON A USER RULING, not a regression test for anything the grid does.
  // The user said list view "visually *looks* clean" — i.e. DO NOT RESTYLE IT —
  // and the grid work had to add a cell wrapper around each row (the spine pill
  // is a <button> and the tile is a <button>, so the pill must be a positioned
  // SIBLING). A wrapper that LAID OUT would have silently changed the rail's
  // geometry, which is exactly the ruling's failure mode. So it is
  // `display: contents` in list view, and that is asserted here rather than
  // assumed: contents produces no box at all, so .slide stays a direct flex
  // child of .slides with the box it always had.
  const listBaseline = await page.evaluate(() => {
    const row = document.querySelector(".slidenav .slide");
    const cell = document.querySelector(".slidenav .slide-cell");
    const cs = getComputedStyle(row);
    return {
      wrapperDisplay: cell ? getComputedStyle(cell).display : null,
      // The rail's own layout, which the ruling protects.
      railDisplay: getComputedStyle(document.querySelector(".slidenav .slides")).display,
      rowDisplay: cs.display,
      rowFlexDirection: cs.flexDirection,
      // The transition is the SLICE between rows in list view, and the row wears
      // no spine of its own — drawing both would state the same fact twice.
      slices: document.querySelectorAll(".slidenav .transition-slice").length,
      spines: document.querySelectorAll(".slidenav .spine").length,
      // A row is full-width in list view: that IS the complaint the grid answers,
      // and it must still be true here.
      rowWidth: Math.round(row.getBoundingClientRect().width),
      railWidth: Math.round(document.querySelector(".slidenav .slides").clientWidth),
    };
  });
  check(listBaseline.wrapperDisplay === "contents",
    `the grid's cell wrapper must be display:contents in LIST view so the rail's boxes are unchanged (user ruling: list view "visually *looks* clean"); got ${listBaseline.wrapperDisplay}`);
  check(listBaseline.railDisplay === "flex", `list view's rail must still be the flex column it shipped as; got ${listBaseline.railDisplay}`);
  check(listBaseline.rowDisplay === "flex" && listBaseline.rowFlexDirection === "column",
    `list view's row must still be the flex column it shipped as; got ${listBaseline.rowDisplay}/${listBaseline.rowFlexDirection}`);
  check(listBaseline.slices >= 1, "list view must still draw the transition SLICE between rows");
  check(listBaseline.spines === 0, "list view must draw NO spine pills — the transition is the slice there, and saying it twice is the defect");

  // ── 1. THE TOGGLE SWITCHES THE LAYOUT, AND THE LAYOUT IS THE POINT ─────────
  // Not merely "a class changed": the assertion is that a tile is now NARROWER
  // than the panel and that several tiles share a row, because "the slides just
  // become enormous" is a complaint about width, and COLUMNS are the answer.
  await toggleView();
  const grid = await page.evaluate(() => {
    const rail = document.querySelector(".slidenav .slides");
    const tiles = [...document.querySelectorAll(".slidenav [data-slide-row]")];
    const boxes = tiles.map((t) => t.getBoundingClientRect());
    // How many tiles share the FIRST row — the column count, read off the layout
    // rather than off the CSS, which is the only way to know what auto-fill did.
    const firstTop = Math.round(boxes[0].top);
    return {
      railDisplay: getComputedStyle(rail).display,
      hasGridClass: document.querySelector(".slidenav").classList.contains("grid"),
      columns: boxes.filter((b) => Math.round(b.top) === firstTop).length,
      tileWidth: Math.round(boxes[0].width),
      railWidth: Math.round(rail.clientWidth),
      tiles: tiles.length,
      slides: window.__powerrp_app.doc.slides.length,
      // The corner index number — the sequence carrier (no flow arrows).
      firstNum: tiles[0].querySelector(".num")?.textContent.trim(),
      // In grid view the between-rows slice is gone: each tile wears its own.
      slices: document.querySelectorAll(".slidenav .transition-slice").length,
    };
  });
  check(grid.hasGridClass, "toggling did not put the rail into its .grid state");
  check(grid.railDisplay === "grid", `grid view's rail must be a CSS grid; got display ${grid.railDisplay}`);
  check(grid.tiles === grid.slides, `every slide must have a tile (${grid.slides} slides, ${grid.tiles} tiles)`);
  check(grid.columns >= 2,
    `grid view must lay tiles in COLUMNS — that is the entire fix for "the slides just become enormous"; only ${grid.columns} tile(s) on the first row at 1600px`);
  check(grid.tileWidth < grid.railWidth / 2,
    `a tile must be far narrower than the panel (the list row was full-width); tile ${grid.tileWidth}px vs rail ${grid.railWidth}px`);
  check(grid.firstNum === "1", `each tile carries its DISPLAY INDEX in the corner (the sequence carrier — no flow arrows); first tile says ${JSON.stringify(grid.firstNum)}`);
  check(grid.slices === 0, "grid view must not also draw the between-rows slice — the tile's own spine pill is that transition");

  // ── 2. THE SPINE PILL: ON EVERY TILE EXCEPT DISPLAY INDEX 1 ───────────────
  // The chip-ownership ruling is what makes this expressible (user: "the tween
  // chips where DO they go....well they belong to the slide they come in with
  // right?"), and the edge ruling is what places it ("why not the left edge when
  // in tile view?" / "u can just rotate the thing 90 degrees including rotating
  // text right"). Slide 1 has no predecessor, so it has no incoming transition
  // and wears a BARE EDGE — asserted, because a pill there would be a claim about
  // a transition that does not exist.
  const pills = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".slidenav .slide-cell")];
    return tiles.map((cell, i) => {
      const pill = cell.querySelector(".spine-pill");
      if (!pill) return { i, present: false };
      const p = pill.getBoundingClientRect();
      const t = cell.querySelector("[data-slide-row]").getBoundingClientRect();
      const cs = getComputedStyle(pill);
      return {
        i,
        present: true,
        writingMode: cs.writingMode,
        opacity: cs.opacity,
        // STRADDLING: the pill's box must cross the tile's LEFT edge — part of it
        // outside (in the gutter), part inside (over the thumbnail). Either one
        // alone would be "beside the tile" or "inside the tile", neither of which
        // is the spine the ruling describes.
        crossesLeftEdge: p.left < t.left && p.right > t.left,
        // It is a SPINE, not a bar: taller than it is wide.
        vertical: p.height > p.width,
        stubs: cell.querySelectorAll(".spine-stub").length,
        label: pill.querySelector(".tr-label")?.textContent.trim() ?? "",
        icon: pill.querySelector("iconify-icon")?.getAttribute("icon"),
        tip: pill.closest("[aria-label]")?.getAttribute("aria-label") ?? pill.getAttribute("aria-label"),
      };
    });
  });
  check(pills[0].present === false,
    "display index 1 must wear NO pill — slide 0 has no predecessor, so there is no incoming transition to name (the list expresses the same fact by having no slice above its first row)");
  for (const p of pills.slice(1)) {
    check(p.present, `tile ${p.i + 1} has no spine pill — every tile but the first wears its own incoming transition`);
    check(/vertical/.test(p.writingMode),
      `the pill must be ROTATED via writing-mode, not transform (user: "u can just rotate the thing 90 degrees including rotating text right"); tile ${p.i + 1} has writing-mode ${p.writingMode}`);
    check(p.vertical, `the pill must read as a book SPINE (taller than wide); tile ${p.i + 1} is not`);
    check(p.crossesLeftEdge,
      `the pill must STRADDLE the tile's left edge — half over the thumbnail, half in the gutter; tile ${p.i + 1}'s pill does not cross it`);
    check(p.opacity === "1",
      `the pill is ALWAYS VISIBLE, never hover-revealed (standing user ruling: "The tween thing should always be there"); tile ${p.i + 1} sits at opacity ${p.opacity}`);
    check(p.stubs === 2, `the hairline stubs run along the edge above AND below the pill (the list's connector vocabulary, rotated); tile ${p.i + 1} has ${p.stubs}`);
    check(p.icon, `the ⛓ icon renders at EVERY condensation step — it is the step below the shortest text; tile ${p.i + 1} has none`);
    // CONDENSATION MAY EMPTY THE LABEL, but never the information: the full
    // sentence is always in the tooltip, which is what makes shortening safe.
    check(/Transition into slide/.test(p.tip ?? ""),
      `the pill must name its transition for a screen reader and carry the full sentence when condensed; tile ${p.i + 1} says ${JSON.stringify(p.tip)}`);
  }

  // ── 2b. NO CLIPPING (user bug report, 2026-08-02, verbatim, two screenshots):
  // "this icon, it doesn't show me anything and it's not tall enough to show me
  // the transition time... Clearly, there's something being cut off." The DD-era
  // pill (writing-mode:vertical-rl end to end) mis-sized a flex sibling of an
  // iconify-icon under vertical-rl and clipped the label's glyphs to slivers at
  // the pill's near edge — measured (not assumed): scrollWidth exceeded
  // clientWidth, and the label's own box spilled outside the pill's box
  // entirely. This asserts the fix by MEASUREMENT, the way the user looked at
  // it: the label's rendered content is never wider than its own box (no
  // horizontal scroll-clip), the label's and icon's boxes are FULLY INSIDE the
  // pill's box on every edge (nothing sliced off at a border), and the seconds
  // text is genuinely present in textContent (not just occupying pixels). */
  const clipping = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".slidenav .slide-cell")];
    return cells.map((cell, i) => {
      const pill = cell.querySelector(".spine-pill");
      if (!pill) return { i, present: false };
      const label = pill.querySelector(".tr-label");
      const icon = pill.querySelector("iconify-icon");
      const pillBox = pill.getBoundingClientRect();
      const fullyInside = (box) => !box ? null : (
        box.left >= pillBox.left - 0.5 && box.right <= pillBox.right + 0.5 &&
        box.top >= pillBox.top - 0.5 && box.bottom <= pillBox.bottom + 0.5
      );
      const iconBox = icon?.getBoundingClientRect();
      const labelBox = label?.getBoundingClientRect();
      return {
        i,
        present: true,
        labelText: label?.textContent ?? null,
        // scrollWidth > clientWidth means the box is truncating rendered glyphs
        // (exactly the "sliver" the report's zoomed screenshot shows).
        labelScrollW: label?.scrollWidth ?? null,
        labelClientW: label?.clientWidth ?? null,
        labelFullyInsidePill: fullyInside(labelBox),
        iconFullyInsidePill: fullyInside(iconBox),
      };
    });
  });
  for (const c of clipping.slice(1)) {
    check(c.present, `tile ${c.i + 1} has no spine pill to measure for clipping`);
    check(c.iconFullyInsidePill,
      `the ⛓ icon must render FULLY INSIDE the pill's own box, not sliced at an edge; tile ${c.i + 1} icon spills outside`);
    if (c.labelText) {
      check(c.labelScrollW <= c.labelClientW,
        `the label's rendered glyphs must fit its own box (scrollWidth <= clientWidth) — the user's report was glyph SLIVERS clipped at the pill's edge; tile ${c.i + 1} label "${c.labelText}" has scrollWidth ${c.labelScrollW} > clientWidth ${c.labelClientW}`);
      check(c.labelFullyInsidePill,
        `the label's box must sit FULLY INSIDE the pill's own box on every edge; tile ${c.i + 1} label "${c.labelText}" spills outside its pill`);
      // THE SECONDS TEXT MUST ACTUALLY BE THERE — the report named the seconds
      // specifically ("it's not tall enough to show me the transition time").
      check(/\d/.test(c.labelText),
        `the visible label must contain the transition's SECONDS digits when it renders at all (the report's specific complaint); tile ${c.i + 1} shows "${c.labelText}" with no digit`);
    }
  }

  // THE PILL SELECTS THE SAME OBJECT THE LIST SLICE SELECTS — not a lookalike.
  // Same app.selectTransitionAt, same shift/cmd multi-select, and the selection
  // SURVIVES a view toggle, which is the sharpest way to say "same object": if
  // the pill built its own selection, toggling to list would lose it.
  const pillSelect = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const ids = app.doc.slides.map((s) => s.id);
    const pillFor = (n) => [...document.querySelectorAll(".slidenav .spine-pill")][n];
    pillFor(0).click();
    const single = app.selectedTransitionIds().length;
    pillFor(1).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    const range = app.selectedTransitionIds().length;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      single, range,
      selectedPills: document.querySelectorAll(".slidenav .spine-pill.selected").length,
      primaries: document.querySelectorAll(".slidenav .spine-pill.primary").length,
      // The ids the selection holds, to compare across the toggle below.
      ids: app.selectedTransitionIds(),
      firstIsSlide1sTransition: app.selectedTransitionIds().includes(ids[1]),
    };
  });
  check(pillSelect.single === 1, `a plain click on a pill selects exactly one transition, got ${pillSelect.single}`);
  check(pillSelect.range === 2, `shift-click on pills must select a RANGE — the V6 transition multi-select, unchanged; got ${pillSelect.range}`);
  check(pillSelect.selectedPills >= 1, "no pill rendered as .selected during a transition multi-selection");
  check(pillSelect.primaries === 1, `exactly one pill is the PRIMARY (the one the Property Panel names), got ${pillSelect.primaries}`);
  check(pillSelect.firstIsSlide1sTransition,
    "clicking the FIRST pill must select the transition INTO the slide that wears it (the chip-ownership ruling), not some other one");

  // ── 3. THE DRAG: LAUNCHPAD SEMANTICS ON THE EXISTING MACHINERY ────────────
  // The user flagged this as the risk ("You do need to be careful with the logic
  // though about dragging slides. It needs to be very clear"), so the assertions
  // are about the PICTURE mid-drag, not about internals: nothing overlaps, the
  // origin cell is empty, the target seam is indicated, and the pills recede so
  // the drop language owns the seams.
  const drag = await page.evaluate(async (SETTLE) => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tiles = [...document.querySelectorAll(".slidenav [data-slide-row]")];
    const idsBefore = app.doc.slides.map((s) => s.id);
    const a = tiles[0].getBoundingClientRect();
    const b = tiles[1].getBoundingClientRect();
    const opts = { bubbles: true, pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" };
    tiles[0].setPointerCapture = () => {};
    tiles[0].dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: a.left + a.width / 2, clientY: a.top + a.height / 2 }));
    // PAST THE MIDLINE OF TILE 1, which in row-major reading order is boundary 2.
    // A PURELY HORIZONTAL MOVE, deliberately: it is the commonest single-step
    // reorder in a grid, and it is the one a vertical-only drag threshold could
    // never start (SlideNav's threshold goes radial in grid view for exactly
    // this). If that regressed, this line moves the pointer and nothing happens.
    tiles[0].dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: b.right - 2, clientY: b.top + b.height / 2 }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const railCursor = getComputedStyle(document.querySelector(".slidenav")).cursor;
    const lifted = document.querySelectorAll(".slidenav .slide.lifted").length;
    const ghost = document.querySelector(".slidenav .drag-ghost");
    const seams = document.querySelectorAll(".slidenav .slide.seam-before, .slidenav .slide.seam-after").length;
    // PILLS DIM so the drop language owns the column seams — the pills sit
    // exactly where the seam must be read, and two bright things on one edge is
    // how a drop target becomes ambiguous.
    const pillOpacity = getComputedStyle(document.querySelector(".slidenav .spine")).opacity;
    // WAIT OUT THE FLIP before measuring geometry: mid-transition the tiles are
    // legitimately between two correct positions.
    await new Promise((r) => setTimeout(r, SETTLE));
    // NOTHING OVERLAPS. The list version of this check caught a real reported bug
    // (rows landing on top of the transition chips), and a grid has strictly more
    // ways to get it wrong — a tile displaced across a row end travels back
    // across the panel and down a line. So assert the PICTURE: no two visible
    // tiles may intersect, on either axis.
    const live = [...document.querySelectorAll(".slidenav .slide:not(.lifted)")].map((el) => el.getBoundingClientRect());
    const overlaps = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const ox = Math.min(live[i].right, live[j].right) - Math.max(live[i].left, live[j].left);
        const oy = Math.min(live[i].bottom, live[j].bottom) - Math.max(live[i].top, live[j].top);
        if (ox > 1 && oy > 1) overlaps.push({ i, j, ox: +ox.toFixed(2), oy: +oy.toFixed(2) });
      }
    }
    // THE ORIGIN CELL STAYS EMPTY (user, of the list drag: "You can leave the old
    // area empty") — the tile keeps its box so nothing reflows, and is drawn as a
    // hole. Measured as: it still occupies layout, and its contents are hidden.
    const lift = document.querySelector(".slidenav .slide.lifted");
    const liftBox = lift?.getBoundingClientRect();
    const liftChildHidden = lift ? getComputedStyle(lift.firstElementChild).visibility === "hidden" : false;
    tiles[0].dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: b.right - 2, clientY: b.top + b.height / 2 }));
    const idsAfter = app.doc.slides.map((s) => s.id);
    app.undo();
    return {
      idsBefore, idsAfter, railCursor, lifted, seams, pillOpacity, overlaps,
      originStillInLayout: !!liftBox && liftBox.width > 0 && liftBox.height > 0,
      liftChildHidden,
      ghost: ghost ? { present: true, position: getComputedStyle(ghost).position, pointerEvents: getComputedStyle(ghost).pointerEvents } : { present: false },
      idsUndone: app.doc.slides.map((s) => s.id),
    };
  }, DRAG_SHIFT_SETTLE_MS);
  check(drag.railCursor === "grabbing", `the cursor must be a closed fist while dragging; got ${drag.railCursor}`);
  check(drag.lifted === 1, `the dragged tile's ORIGIN CELL must be left empty as a .lifted hole; got ${drag.lifted}`);
  check(drag.originStillInLayout,
    "the lifted tile must KEEP its box (drawn as a hole, not removed) — removing it would reflow the grid under the cursor, which is the thing the bold-only ruling protects against");
  check(drag.liftChildHidden, "the lifted tile's contents must be hidden — the origin cell reads as EMPTY while the ghost carries the tile");
  check(drag.ghost.present, "no .drag-ghost followed the pointer (user, of the list drag: \"make it literally drag the slide\")");
  check(drag.ghost.position === "fixed", `the ghost must be position:fixed so panel scrolling cannot drift it off the cursor; got ${drag.ghost.position}`);
  check(drag.ghost.pointerEvents === "none", "the ghost must not be hit-testable — it would become the drop target it is hovering");
  check(drag.seams === 1, `exactly ONE tile edge must indicate the target seam; got ${drag.seams}`);
  check(Number(drag.pillOpacity) < 1,
    `the pills must DIM during a drag so the drop language owns the column seams (settled design); they sit at opacity ${drag.pillOpacity}`);
  check(drag.overlaps.length === 0,
    `no two tiles may intersect mid-drag — a displaced tile must land in a CELL, including across a row wrap; ${JSON.stringify(drag.overlaps)}`);
  // AND THE DROP REORDERS, appearance-preservingly and in one undo unit. The
  // appearance law itself is proven for every permutation in bare node
  // (tests/slide_reorder_test.js); what this asserts is that the GRID's gesture
  // reaches that same primitive rather than a splice of its own.
  check(drag.idsAfter[0] === drag.idsBefore[1] && drag.idsAfter[1] === drag.idsBefore[0],
    `the grid drop did not reorder: ${drag.idsBefore.slice(0, 2)} → ${drag.idsAfter.slice(0, 2)}`);
  check(drag.idsUndone.join() === drag.idsBefore.join(), "a grid drop is not ONE undo unit — one undo did not restore the order");

  // ── 4. THE PREFERENCE PERSISTS, AND IT IS NOT DOCUMENT STATE ──────────────
  // Two halves of one ruling. It must SURVIVE a reload (it is a preference), and
  // it must be absent from the DOCUMENT (it is not a fact about the deck: two
  // people opening the same project may disagree without either being wrong).
  const stored = await page.evaluate(() => ({
    view: localStorage.getItem("powerrp.slideNavView"),
    docMentionsView: JSON.stringify(window.__powerrp_app.doc).includes("slideNavView"),
  }));
  check(stored.view === "grid", `the view must persist to localStorage as the MODE NAME; got ${JSON.stringify(stored.view)}`);
  check(!stored.docMentionsView, "the view mode must NOT be in the document — it is a browser preference, not document state, and never keyframeable");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".slidenav [data-slide-row]");
  const afterReload = await page.evaluate(() => document.querySelector(".slidenav").classList.contains("grid"));
  check(afterReload, "the grid view did not survive a reload — the preference is not being read back at mount");

  // ── 5. TOGGLING BACK RESTORES LIST VIEW EXACTLY ──────────────────────────
  // The other half of the do-not-restyle guard: not only is list view unchanged
  // at boot, it is unchanged after a round trip through the grid. A toggle that
  // left residue behind would satisfy section 0 and still break the ruling.
  await toggleView();
  const backToList = await page.evaluate(() => {
    const row = document.querySelector(".slidenav .slide");
    const cs = getComputedStyle(row);
    return {
      wrapperDisplay: getComputedStyle(document.querySelector(".slidenav .slide-cell")).display,
      railDisplay: getComputedStyle(document.querySelector(".slidenav .slides")).display,
      rowDisplay: cs.display,
      rowFlexDirection: cs.flexDirection,
      slices: document.querySelectorAll(".slidenav .transition-slice").length,
      spines: document.querySelectorAll(".slidenav .spine").length,
      rowWidth: Math.round(row.getBoundingClientRect().width),
    };
  });
  check(backToList.wrapperDisplay === listBaseline.wrapperDisplay
    && backToList.railDisplay === listBaseline.railDisplay
    && backToList.rowDisplay === listBaseline.rowDisplay
    && backToList.rowFlexDirection === listBaseline.rowFlexDirection
    && backToList.slices === listBaseline.slices
    && backToList.spines === listBaseline.spines,
    `list view must come back EXACTLY as it was (user: it "visually *looks* clean"); before ${JSON.stringify(listBaseline)} after ${JSON.stringify(backToList)}`);

  // ── 6. THE ASSET EXPLORER'S MIRRORED TOGGLE AND ITS NEW LIST VIEW ─────────
  // User: "You can have the same thing for the asset explorer too." This pane had
  // only TILES, so the toggle ADDS a view rather than choosing between two. The
  // rows carry name · kind · size — the facts the tile keeps in its tooltip,
  // promoted to always-visible columns, which is what the view is for.
  //
  // TOLERANT OF AN EMPTY LIBRARY, deliberately: a probe run without a BACKEND_URL
  // has no project assets (the ignore list above swallows that 500), so the
  // built-ins are turned ON to guarantee there is something to render. Asserting
  // rows exist against an empty library would make this probe fail for a reason
  // that has nothing to do with the view.
  const ae = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    if (!app.showBuiltinAssets) app.toggleShowBuiltinAssets();
    await new Promise((r) => setTimeout(r, 200));
    const toggle = document.querySelector(".asset-explorer [data-ae-view]");
    if (!toggle) return { toggle: false };
    const before = { grid: document.querySelectorAll(".asset-explorer .ae-grid").length, list: document.querySelectorAll(".asset-explorer .ae-list").length };
    toggle.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rows = [...document.querySelectorAll(".asset-explorer .ae-row")];
    const first = rows[0];
    return {
      toggle: true,
      before,
      after: { grid: document.querySelectorAll(".asset-explorer .ae-grid").length, list: document.querySelectorAll(".asset-explorer .ae-list").length },
      rows: rows.length,
      // NAME · KIND · SIZE — the three columns the view exists to show.
      columns: first ? {
        name: first.querySelector(".ae-row-name")?.textContent.trim(),
        kind: first.querySelector(".ae-row-kind-text")?.textContent.trim(),
        hasSizeCell: !!first.querySelector(".ae-row-size"),
      } : null,
      // The row keeps the tile's gestures — a layout switch, never a capability switch.
      draggable: first?.getAttribute("draggable"),
      stored: localStorage.getItem("powerrp.assetExplorerView"),
    };
  });
  check(ae.toggle, "the Asset Explorer has no view toggle — the user asked for the same control in both panels");
  check(ae.before.grid === 1 && ae.before.list === 0, `the Asset Explorer must START in tile view (its only view until now); got ${JSON.stringify(ae.before)}`);
  check(ae.after.list === 1 && ae.after.grid === 0, `the toggle must swap the pane to LIST view; got ${JSON.stringify(ae.after)}`);
  check(ae.stored === "list", `the Asset Explorer's view must persist as the mode name; got ${JSON.stringify(ae.stored)}`);
  check(ae.rows >= 1, `list view must render one row per shown asset; got ${ae.rows} with built-ins on`);
  check(ae.columns && ae.columns.name && ae.columns.kind && ae.columns.hasSizeCell,
    `a row must carry name · kind · size — the facts the tile hides in its tooltip; got ${JSON.stringify(ae.columns)}`);
  check(ae.draggable === "true",
    "a list row must stay draggable onto the canvas — the toggle changes the LAYOUT, never what the pane can do");

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("SLIDE GRID PROBE OK: the toggle lays slides in COLUMNS (so a wider panel shows more slides, not bigger ones) and persists as a browser preference that is absent from the document; every tile but display index 1 wears its incoming transition as an always-visible vertical pill straddling its left edge, selecting the same transition object the list slice selects, with its icon and label measured FULLY INSIDE the pill's own box and the label's rendered glyphs never wider than their box (the AR fix for the reported clipping); a horizontal grid drag lifts a ghost, leaves its origin cell empty, dims the pills, marks exactly one seam, tiles without a single overlap and reorders in one undo unit; list view is byte-for-byte the layout it shipped as, before and after the round trip; the Asset Explorer's mirrored toggle adds name·kind·size rows that keep the tile's drag. Zero console errors.");
} finally {
  await browser.close();
  await server.close();
}
