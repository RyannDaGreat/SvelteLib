/**
 * SLIDE STRIP probe — the rail's gestures, end to end in a real browser: the
 * transition slice's SHAPE, DRAG-TO-REORDER (and what it LOOKS like), the
 * multi-select + slide clipboard commands, the FOOTER's button set, and
 * TRANSITION multi-select.
 *
 * SEVERAL ASSERTIONS HERE PIN USER CORRECTIONS OF A DESIGN THAT SHIPPED, and each
 * is marked at its site with the quote that overruled it (2026-08-02): the insert
 * `+` ends are RETRACTED and their absence is asserted, the chip is always visible
 * rather than hover-revealed, the hover surface is the whole gap rather than the
 * chip, and a drag boundary goes bold WITHOUT opening space. Where a pin was
 * inverted, that is said — a pin quietly deleted is how a rejected design creeps
 * back.
 *
 *   node src/demo_apps/PowerRP/tests/slide_strip_probe.js
 *
 * WHY A PROBE AND NOT ANOTHER NODE TEST. The core math is already pinned in
 * bare node (tests/slide_reorder_test.js proves the appearance law for every
 * permutation, for paste and for the block move). What node cannot see is the
 * WIRING: that the slice renders as the chip and nothing else, that a pointer
 * drag on a row produces a boundary and commits through moveSlidesToBoundary,
 * and that the rail's click rule builds the selection the clipboard commands
 * then read. Those are the seams a
 * refactor silently breaks — and a MISSING NAMED IMPORT IS SILENT IN THIS BUILD
 * (CLAUDE.md, measured), so a green build proves nothing about them.
 *
 * NO SCREENSHOTS, deliberately. 64 of the browser probes call page.screenshot,
 * and on a host whose capture path hangs each one burns its full protocol
 * timeout and dies with a stack that reads like an app regression (CLAUDE.md's
 * browser_capture_preflight note). Everything here is assertable from
 * page.evaluate, so this probe has no reason to take that risk.
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
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  // The boot-noise exclusions every rail/nav probe carries: a headless
  // layout-timing paint race in CanvasView, SwiftShader having no WebGPU adapter
  // for the VideoV7 overlay, and the project-API 500/ECONNREFUSED a probe sees
  // whenever no BACKEND_URL is pointed at a running project server (the gate
  // supplies one; run by hand it does not — CLAUDE.md's note that ~9 of the first
  // sweep's 12 failures were exactly this absent dependency). None of the three
  // is on the slide rail's path; the boot_probe.js IGNORE list is the precedent.
  const ignore = (t) => /zero-sized canvas|VideoV7: WebGPU init failed|Failed to load resource|\/api\/|listAssets|500 \(Internal Server Error\)|ECONNREFUSED/i.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".slidenav [data-slide-row]");

  // ── 1. THE SLICE IS THE CHIP ALONE ─────────────────────────────────────────
  // THE `+` ENDS ARE GONE, and this block is the INVERSION of the pin that used
  // to require them. The user asked for the three-zone slice on 2026-08-02 and
  // retracted it the same day: "the insert a slide here up and down buttons that
  // we have near the tween line… I made a mistake that feature should never have
  // existed we can get rid of that just just tween is fine we don't need those
  // extra up and down add slide up and add slide down buttons on either side of
  // tween 0.5… we can get rid of the up plus and down plus buttons here."
  //
  // So `ends === 0` is asserted rather than the pin merely deleted: a retracted
  // affordance that leaves no assertion behind is one an agent re-adds from the
  // still-present app.insertSlideAtBoundary, reading its docblock as a TODO. The
  // ends' ABSENCE is now the requirement, and it is checked in the markup.
  //
  // THE CHIP'S OWN PIN IS UNCHANGED and is itself an earlier inversion: this probe
  // once asserted `idleChipOpacity === "0"`, overruled by "I don't see tween 0.5
  // seconds unless I hover over it now, which is not ideal… The tween thing should
  // always be there."
  const zones = await page.evaluate(() => {
    const slice = document.querySelector(".transition-slice");
    return {
      ends: slice.querySelectorAll(".tr-end").length,
      chips: slice.querySelectorAll(".tr-chip").length,
      buttons: slice.querySelectorAll("button").length,
      idleChipOpacity: getComputedStyle(slice.querySelector(".tr-chip")).opacity,
    };
  });
  check(zones.ends === 0, `the retracted insert-slide "+" ends must not exist; found ${zones.ends}`);
  check(zones.chips === 1, `expected 1 transition chip on a slice, got ${zones.chips}`);
  check(zones.buttons === 1, `the slice's only control is the chip; found ${zones.buttons} buttons`);
  check(zones.idleChipOpacity === "1", `the transition CHIP must be visible without hovering (user ruling); opacity ${zones.idleChipOpacity}`);

  // HOVERING ANYWHERE IN THE GAP lights the band — the hover surface is the whole
  // inter-slide band, not the chip (user: "The hover area should be the entire in
  // between of the slides, not just a small subset"). It no longer REVEALS
  // anything (the ends it revealed are retracted), so what is checked is that the
  // band takes `.hot` from a pointer over the band itself, and deliberately not
  // over the chip: hovering the chip would pass even if the band handed hover to
  // its children only, which is the defect being ruled out.
  await page.hover(".transition-slice");
  const hot = await page.evaluate(() => {
    const slice = document.querySelector(".transition-slice");
    return { hot: slice.classList.contains("hot"), chip: getComputedStyle(slice.querySelector(".tr-chip")).opacity };
  });
  check(hot.hot, "hovering anywhere in the gap must make the band .hot");
  check(hot.chip === "1", `the chip stays visible while hot (opacity ${hot.chip})`);

  // ── 2. MULTI-SELECT, and the clipboard commands that read it ───────────────
  const multi = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    app.selectSlideAt(1, { shift: true }); // range
    const range = app.selectedSlideIndices();
    app.selectSlideAt(0, { toggle: true }); // drop one back out
    const toggled = app.selectedSlideIndices();
    return { range, toggled, rowsSelected: document.querySelectorAll(".slidenav .slide.selected").length };
  });
  check(multi.range.length === 2, `shift-click should select a RANGE of 2, got ${JSON.stringify(multi.range)}`);
  check(multi.toggled.length === 1, `cmd-click should toggle one out, leaving 1; got ${JSON.stringify(multi.toggled)}`);
  check(multi.rowsSelected >= 1, "no rail row rendered as .selected after a multi-select");

  const clipboard = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    app.selectSlideAt(1, { shift: true });
    const before = app.doc.slides.length;
    app.runCommand("copy-slides");
    const copied = app.slideClipboardCount();
    app.runCommand("paste-slides");
    return { before, copied, after: app.doc.slides.length, pastedSelection: app.selectedSlideIndices().length };
  });
  check(clipboard.copied === 2, `copy-slides should hold 2 slides, holds ${clipboard.copied}`);
  check(clipboard.after === clipboard.before + 2, `paste-slides should add 2 slides (${clipboard.before} → ${clipboard.after})`);
  check(clipboard.pastedSelection === 2, `the pasted block should become the selection (got ${clipboard.pastedSelection})`);
  await page.evaluate(() => window.__powerrp_app.undo());

  // ── 3. DRAG-TO-REORDER, through real pointer events ────────────────────────
  // Drag row 0 past the middle of row 1: it must land at boundary 2 and the deck
  // must come back in the swapped order, in ONE undo unit.
  // Long enough to outlast the rows' 0.3s slide-aside (SlideNav's DRAG_SHIFT_MS)
  // before the tiling is measured — see the overlap block below for why the read
  // must not land mid-easing.
  const DRAG_SHIFT_SETTLE_MS = 600;
  const drag = await page.evaluate(async (DRAG_SHIFT_SETTLE_MS) => {
    const app = window.__powerrp_app;
    app.selectSlideAt(0);
    // LET LAYOUT SETTLE BEFORE MEASURING. The rows are measured with
    // getBoundingClientRect, and the preceding undo re-renders the rail; under a
    // loaded machine (the gate runs suites in parallel) the read can land before
    // the new heights are in, which puts the synthetic pointer at a Y that
    // resolves to the wrong boundary. One frame of quiet removes the race — and
    // it is a race in the PROBE's measurement, not in the app: boundaryAt reads
    // the same rects the browser paints.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rows = [...document.querySelectorAll(".slidenav [data-slide-row]")];
    const idsBefore = app.doc.slides.map((s) => s.id);
    // Baseline for the no-reflow check below: where the last row SITS IN LAYOUT
    // before anything is dragged.
    const layoutTopBefore = rows[rows.length - 1].offsetTop;
    const a = rows[0].getBoundingClientRect();
    const b = rows[1].getBoundingClientRect();
    const opts = { bubbles: true, pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" };
    // setPointerCapture on a synthetic pointerId throws in Chrome unless the id
    // is live, so stub it for the gesture — the capture is a convenience (it
    // keeps a release outside the rail working), never part of the math.
    rows[0].setPointerCapture = () => {};
    rows[0].dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: a.left + 10, clientY: a.top + a.height / 2 }));
    rows[0].dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: a.left + 10, clientY: b.bottom - 2 }));
    // Svelte flushes DOM updates asynchronously, so the drag CLASSES are not on
    // the elements yet in this same tick — wait one frame before reading them.
    // (The reorder itself is synchronous state, hence no wait around the drop.)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const railDragging = document.querySelector(".slidenav").classList.contains("dragging");
    const dropShown = document.querySelectorAll(".slidenav .drop, .slidenav .transition-slice.drop").length;
    // WHAT THE DRAG LOOKS LIKE, per the user's 2026-08-02 corrections. Each of
    // these replaced a behaviour that shipped and was rejected, so each is pinned:
    //   · the dragged row's slot is a HOLE (.lifted), left in place, not removed
    //   · a GHOST follows the pointer ("make it literally drag the slide")
    //   · the cursor is a CLOSED FIST
    //   · the boundary goes BOLD ONLY — no margin opens ("It should just be bold")
    const lifted = document.querySelectorAll(".slidenav .slide.lifted").length;
    const ghost = document.querySelector(".slidenav .drag-ghost");
    const railCursor = getComputedStyle(document.querySelector(".slidenav")).cursor;
    // THE MEASUREMENT IS THE ROW'S POSITION, NOT A MARGIN VALUE. Reading
    // margin-top off the drop slice cannot answer this: the slice carries a
    // NEGATIVE margin on purpose (it is how the band claims the whole gap as its
    // hover surface without taking extra layout), so a margin assertion would
    // fail on a correct implementation and pass on a wrong one that used padding
    // instead. What the user actually objected to is the rail MOVING —
    // "the space between the slides gets bigger" — so measure that: the last
    // row's top before vs during the drag, which is the accumulation of every
    // gap above it. Transform-based shifts do not count here, deliberately;
    // they are the rows making way, which is the behaviour that was ASKED for.
    const lastRow = rows[rows.length - 1];
    const layoutTopDuring = lastRow.offsetTop;
    // A row that must make way carries a non-zero translate, and it is a
    // TRANSFORM (compositable, cannot reflow) rather than a margin/height.
    const shifted = [...document.querySelectorAll(".slidenav .slide")]
      .map((r) => getComputedStyle(r).transform)
      .filter((t) => t && t !== "none" && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(t)).length;
    // ── THE PUSHED ROWS MUST TILE, NOT OVERLAP THE CHIPS ────────────────────
    // User, 2026-08-02: "when I'm dragging and dropping these different slides,
    // the ones that move out of the way don't move into quite the right place.
    // It's mostly good, but it's not quite there… You see how slide 1 intersects
    // on top of where it says tween? … Is the math off anywhere?" It was: rows
    // shifted by their own HEIGHT, but a row's SLOT also contains the transition
    // slice and the flex gaps on either side of it, so every displaced row landed
    // one slice short and parked on the chip above it. Measured on this rail at
    // the time: rows 144.31 tall, pitch 165.31 — a 21px shortfall that put row 1
    // (73→217.31) straight through chip 1 (200.31→213.31).
    //
    // ASSERT THE PICTURE, NOT THE NUMBER. What the user reported is an
    // INTERSECTION, so intersection is what is checked — every mid-drag row box
    // against every chip box. A pin on "shift === 165.31" would encode this
    // rail's current row height and break the moment a thumbnail aspect or a
    // token changed, while still not saying the thing that was wrong.
    // Wait out the 0.3s CSS slide first: mid-transition the rows are legitimately
    // between two correct positions, and reading there would measure the easing.
    await new Promise((r) => setTimeout(r, DRAG_SHIFT_SETTLE_MS));
    const boxes = (sel) => [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect());
    const overlaps = [];
    for (const row of boxes(".slidenav .slide:not(.lifted)")) {
      for (const chip of boxes(".slidenav .tr-chip")) {
        const over = Math.min(row.bottom, chip.bottom) - Math.max(row.top, chip.top);
        if (over > 0) overlaps.push({ over: +over.toFixed(2), row: +row.top.toFixed(2), chip: +chip.top.toFixed(2) });
      }
    }
    rows[0].dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: a.left + 10, clientY: b.bottom - 2 }));
    const idsAfter = app.doc.slides.map((s) => s.id);
    app.undo();
    return {
      idsBefore, idsAfter, railDragging, dropShown, lifted, railCursor, shifted, overlaps,
      layoutTopBefore, layoutTopDuring,
      ghost: ghost ? { present: true, text: ghost.textContent.trim(), pointerEvents: getComputedStyle(ghost).pointerEvents, position: getComputedStyle(ghost).position } : { present: false },
      idsUndone: app.doc.slides.map((s) => s.id),
    };
  }, DRAG_SHIFT_SETTLE_MS);
  check(drag.railDragging, "the rail did not enter its .dragging state during a row drag");
  check(drag.dropShown >= 1, "no drop indicator was drawn at the boundary under the cursor");
  check(drag.railCursor === "grabbing", `the cursor must be a closed fist while dragging (user ruling); got ${drag.railCursor}`);
  check(drag.lifted === 1, `the dragged row's slot must be left EMPTY as a .lifted hole; got ${drag.lifted}`);
  check(drag.ghost.present, "no .drag-ghost followed the pointer (user: \"make it literally drag the slide\")");
  check(drag.ghost.position === "fixed", `the ghost must be position:fixed so rail scrolling cannot drift it off the cursor; got ${drag.ghost.position}`);
  check(drag.ghost.pointerEvents === "none", "the ghost must not be hit-testable — it would become the drop target it is hovering");
  check(drag.shifted >= 1, "no row translated to open the drop slot (\"push the others out of the way\")");
  // THE PUSHED ROWS TILE WITH THE CHIPS. The shortfall this catches shipped, and
  // the user reported the picture it made ("You see how slide 1 intersects on top
  // of where it says tween?"). A row that made way must land in a SLOT, and a slot
  // includes the transition slice below it — so a displaced row's box may never
  // intersect a chip's box.
  check(drag.overlaps.length === 0,
    `a row that moved aside overlaps a transition chip — the push-aside distance is short by the slice+gaps (user: "slide 1 intersects on top of where it says tween"); ${JSON.stringify(drag.overlaps)}`);
  // THE BOUNDARY GOES BOLD, NOT WIDE. A margin here is the rejected design, and
  // it is asserted absent rather than merely unasserted, because "the space
  // between the slides gets bigger" is precisely what the user objected to.
  check(drag.layoutTopDuring === drag.layoutTopBefore,
    `the rail must NOT reflow when a drag starts — bold boundary only, no gap (user ruling); last row's layout top moved ${drag.layoutTopBefore} → ${drag.layoutTopDuring}`);
  check(drag.idsAfter[0] === drag.idsBefore[1] && drag.idsAfter[1] === drag.idsBefore[0],
    `the drop did not reorder: ${drag.idsBefore.slice(0, 2)} → ${drag.idsAfter.slice(0, 2)}`);
  check(drag.idsUndone.join() === drag.idsBefore.join(), "a drop is not ONE undo unit — one undo did not restore the order");

  // ── 3b. THE FOOTER IS FIVE BUTTONS, AND ITS ICONS COME FROM THE COMMANDS ───
  // User, 2026-08-02: "Remember how I asked to simplify the set of buttons? I
  // still see two pluses and also a copy." The row was six — `+ · boxed-+ · up ·
  // down · copy · trash` — two of them pluses, and the copy did what one of the
  // pluses already did ("duplicate slide is not really needed, because new slide
  // after current does exactly the same thing"). So the bare `+` and the separate
  // Duplicate BUTTON are gone, and their absence is asserted rather than the pin
  // merely deleted: a retracted button that leaves no assertion behind is one an
  // agent re-adds. duplicate-slides stays REGISTERED — this pins the footer, not
  // the command, and the palette/Cmd+D route to it is untouched.
  //
  // THE ICON CHECK IS THE POINT OF THE OTHER HALF. The footer used to hardcode
  // glyphs, so when d3a0080 changed new-slide's icon on the PALETTE entry the
  // ruling reached the palette and not this row. Asserting the button's icon
  // EQUALS its entry's icon makes the two inexpressibly different: any future
  // icon ruling lands in one place and this row follows it by construction.
  //
  // IT COUNTS THE COMMAND BUTTONS, VIA [data-nav-action], AND NOT EVERY BUTTON IN
  // THE ROW. The selector used to be `.nav-actions button`, which was the same set
  // right up until the footer gained a control that is NOT a command — the
  // list/grid VIEW TOGGLE (2026-08-02), which changes how the panel draws itself
  // for one browser and is deliberately not in the registry (SlideNav's
  // VIEW_TOGGLE_ICONS note argues that at length). Under the old selector that
  // toggle read as a sixth footer command and failed this check with
  // `new-slide,…,delete-slides,` — a trailing EMPTY name, which is the tell: an
  // element with no data-nav-action was being counted as one.
  //
  // THE PIN IS UNWEAKENED, because what the user retracted was three COMMANDS
  // ("I still see two pluses and also a copy"), and the assertion below still says
  // exactly which five commands the row surfaces and in what order. Adding a
  // non-command control cannot smuggle a sixth command past it; adding a sixth
  // command still fails it. Widening the selector to "every button" would instead
  // have made the row's chrome unextendable, which is not what was ruled.
  const footer = await page.evaluate(() => {
    const app = window.__powerrp_app;
    return {
      buttons: [...document.querySelectorAll(".slidenav .nav-actions button[data-nav-action]")].map((b) => ({
        cmd: b.dataset.navAction,
        icon: b.querySelector("iconify-icon")?.getAttribute("icon"),
        entryIcon: b.dataset.navAction ? app.commands.get(b.dataset.navAction).icon : null,
      })),
      duplicateStillRegistered: !!app.commands.get("duplicate-slides"),
    };
  });
  check(footer.buttons.length === 5,
    `the rail footer is FIVE buttons after the user's simplification; got ${footer.buttons.length}: ${footer.buttons.map((b) => b.cmd)}`);
  check(footer.buttons.map((b) => b.cmd).join() === "new-slide,new-blank-slide,move-slide-up,move-slide-down,delete-slides",
    `unexpected footer commands: ${footer.buttons.map((b) => b.cmd)}`);
  check(!footer.buttons.some((b) => b.cmd === "duplicate-slides"),
    "the Duplicate BUTTON is retracted from the footer (user: \"duplicate slide is not really needed, because new slide after current does exactly the same thing\")");
  check(footer.duplicateStillRegistered,
    "duplicate-slides must stay REGISTERED — the retraction was of the footer button, not of the command");
  check(!footer.buttons.some((b) => b.icon === "mdi:plus"),
    "the bare `+` is retracted — the user counted \"two pluses\" and New Slide After Current now wears the palette's copy glyph");
  for (const b of footer.buttons) {
    check(b.icon && b.icon === b.entryIcon,
      `the footer must READ its icon from the command entry, never hardcode it — ${b.cmd} draws ${b.icon} while its entry says ${b.entryIcon} (this exact drift is why an icon ruling missed this row once)`);
  }

  // ── 4. TRANSITION MULTI-SELECT, and the batch write it feeds ───────────────
  // User, 2026-08-02: "I should be able to shift click multiple tweens too, in the
  // same way that I have multi-selection for widgets. It's exactly the same idea."
  // So the same three gestures are asserted here that section 2 asserts for rows,
  // plus the property the phrase "exactly the same idea" actually commits us to:
  // a batch edit is ONE undo unit, not one per transition.
  const tr = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const ids = app.doc.slides.map((s) => s.id);
    app.selectTransitionAt(ids[1]);
    const single = app.selectedTransitionIds().length;
    app.selectTransitionAt(ids[2], { shift: true }); // range 1..2
    const range = app.selectedTransitionIds().length;
    app.selectTransitionAt(ids[2], { toggle: true }); // drop one back out
    const toggled = app.selectedTransitionIds().length;
    // Batch-set duration over a real multi-selection, then undo ONCE.
    app.selectTransitionAt(ids[1]);
    app.selectTransitionAt(ids[2], { shift: true });
    const targets = app.selectedTransitionIds();
    app.setSelectedTransitionsProp("seconds", 1.25);
    const after = targets.map((id) => app.transitionAt(id).seconds);
    app.undo();
    const undone = targets.map((id) => app.transitionAt(id).seconds);
    // Re-select for the DOM reads below and let Svelte flush: the classes are not
    // on the chips in the same tick as the state write (the drag section above
    // documents the same asynchrony).
    app.selectTransitionAt(ids[1]);
    app.selectTransitionAt(ids[2], { shift: true });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      single, range, toggled, after, undone,
      chipsSelected: document.querySelectorAll(".slidenav .tr-chip.selected").length,
      primaries: document.querySelectorAll(".slidenav .tr-chip.primary").length,
      // Item and transition selection stay mutually exclusive.
      itemSelectionCleared: app.selection === null,
    };
  });
  check(tr.single === 1, `a plain click selects exactly one transition, got ${tr.single}`);
  check(tr.range === 2, `shift-click must select a RANGE of transitions, got ${tr.range}`);
  check(tr.toggled === 1, `cmd-click must toggle one transition out, leaving 1; got ${tr.toggled}`);
  check(tr.after.every((s) => s === 1.25), `a batch duration write must reach EVERY selected transition, got ${JSON.stringify(tr.after)}`);
  check(tr.undone.every((s) => s !== 1.25), `the batch write must be ONE undo unit; after one undo: ${JSON.stringify(tr.undone)}`);
  check(tr.chipsSelected >= 1, "no transition chip rendered as .selected during a multi-selection");
  check(tr.primaries === 1, `exactly one chip is the PRIMARY (the one the panel names), got ${tr.primaries}`);
  check(tr.itemSelectionCleared, "selecting a transition must clear the item selection (they are mutually exclusive)");

  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
  console.log("SLIDE STRIP PROBE OK: the slice is the always-visible chip ALONE (the retracted + ends are absent) and the whole gap makes the band hot; shift/cmd build the rail selection; copy+paste round-trips 2 slides; a pointer drag lifts a ghost, shifts the others into SLOTS that clear the chips and reorders in one undo unit with a bold-not-wider boundary; the footer is five buttons drawing the icons its command entries declare; transitions shift/cmd multi-select and batch-write in one undo unit. Zero console errors.");
} finally {
  await browser.close();
  await server.close();
}
