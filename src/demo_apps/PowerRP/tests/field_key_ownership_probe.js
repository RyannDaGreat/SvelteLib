/**
 * FIELD-KEY-OWNERSHIP probe: a focused numeric field must own the plain keyboard,
 * so that editing a number cannot fire a canvas command behind it.
 *
 * THE DEFECT THIS MEASURES. lib/DraggableNumber renders a `div[role=spinbutton]`
 * and web/AngleField a `svg[role=slider]` — neither is an INPUT/TEXTAREA/SELECT/
 * contenteditable, so App.svelte's isTypingTarget() reports FALSE for both and the
 * registry keeps dispatching every canvas key while one of them holds focus. With
 * a widget selected and its number focused, Backspace ran `delete-item` and
 * DELETED THE WIDGET, Left/Right changed slide, and G started a modal grab. The
 * fix is the Modal/TextEditController one: the focused control claims the
 * keystrokes that are its own (src/lib/fieldKeys.js fieldOwnsKeydown), and lets
 * the host's MODIFIED combos (Cmd+Z and friends) keep bubbling.
 *
 * Every check is app state measured BEFORE and AFTER exactly one keypress, in the
 * real editor, driven through page.keyboard — the escape_propagation_probe.js
 * technique (same boot, same launch args, same console-noise allowance).
 *
 * The three groups, and why all three are needed:
 *   1. THE LEAKS — one keypress each, with a field focused and a widget selected:
 *      the widget survives Backspace/Delete, the slide does not change on
 *      Left/Right, and G/B/P/Space start nothing.
 *   2. THE FIELD'S OWN KEYS still work — arrow nudge, Home/End to the bounds on a
 *      bounded row, and Shift making a live drag FINE_FACTOR finer. Swallowing
 *      everything would be as wrong as swallowing nothing, so this half is not
 *      optional.
 *   3. WHAT MUST STILL BUBBLE — Cmd+Z (app undo legitimately works while a field
 *      is focused) and Escape (the wrapper above the scrubber claims it to revert
 *      a live preview; a control that swallowed it would break its own host).
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/field_key_ownership_probe.js
 * An optional argument is a directory to drop screenshots in (editor_smoke.js's
 * convention) — the checks are identical with or without it.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

// Paths resolve from THIS file, never process.cwd() — a cwd-relative path
// silently doubles when the suite is run from the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(here, "..");
const webRoot = resolve(powerrp, "web");
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

// SwiftShader/ANGLE: this container has no GPU, and the editor's Skia surface
// needs a WebGL2 context to boot at all.
const LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"];
// Stale-fixture boot noise other agents' in-flight migrations emit (the same
// allowance escape_propagation_probe.js makes), plus this container's headless
// graphics reality: the demo fixture carries video widgets that probe for an
// adapter the software renderer does not expose and fall back.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];

// lib/DraggableNumber.svelte's own Shift multiplier, mirrored so the fine-drag
// check computes what the component computes.
const FINE_FACTOR = 0.1;
// Drag distance for the coarse/fine comparison. Big enough that a bounded row's
// coefficient (web/NumericField RANGE_DRAG_PX = 100 px across the full range)
// moves the value well clear of its step grid at BOTH sensitivities.
const DRAG_PX = 40;

// hmr: false — the probe drives the app through a long stateful sequence, and a
// hot update (any editor save anywhere in the tree) reloads the page mid-run and
// throws away the widget the checks are measuring. Nothing here needs live reload.
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser({ args: LAUNCH_ARGS });

const shotDir = process.argv[2] ?? null;
if (shotDir) await mkdir(shotDir, { recursive: true });

const checks = [];
const errors = [];
// Logged as it happens, not batched at the end (src/demos/DraggableNumber/test_dn.js's
// shape): this probe drives a long stateful sequence, and a batched log prints
// NOTHING when a step throws part-way — which is exactly when the transcript matters.
const ok = (cond, label) => {
  checks.push([!!cond, label]);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) errors.push(`CHECK FAILED: ${label}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || IGNORE_BOOT.some((re) => re.test(m.text()))) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: 20000 });
  await pause(800);
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /** Command. Writes a screenshot when a shot directory was requested. */
  const shot = async (name) => { if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` }); };

  /** The app state one keypress can plausibly disturb, as one snapshot.
   * `itemAlive` reads the DERIVED tree, not state().items: Delete KEYFRAMES
   * `active: false` (the item stays in the document, deactivated on this slide),
   * so state().items still holds it and only nodes() reflects the deletion —
   * measuring the wrong one made the destructive leak look harmless. */
  const snap = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const el = document.activeElement;
    return {
      sel: app.selection,
      itemAlive: app.nodes().some((n) => n.itemId === id),
      slideIndex: app.slideIndex,
      mode: app.mode,
      dragging: app.dragging,
      dragKind: app.dragKind,
      modal: !!app.modalXform,
      crosshair: app.crosshair?.kind ?? null,
      palette: app.paletteOpen,
      textEditing: !!app.textEditing,
      docIsBefore: JSON.stringify(app.doc) === window.__fieldProbeDoc,
      // What the FOCUSED control is and what value it publishes — the field's own
      // keys are measured through the same ARIA the focus tracker classifies it by.
      activeRole: el?.getAttribute?.("role") ?? null,
      activeLabel: el?.getAttribute?.("aria-label") ?? null,
      valueNow: el?.getAttribute?.("aria-valuenow") ?? null,
    };
  }, id);
  /** Command (in-page). Stashes the CURRENT document's serialization, so a later
   * `docIsBefore` proves nothing was committed. Compared as JSON, not by
   * reference (escape_propagation_probe.js's markDoc, same reasoning). */
  const markDoc = () => page.evaluate(() => { window.__fieldProbeDoc = JSON.stringify(window.__powerrp_app.doc); });
  /** Command (in-page). Puts the app back exactly where markDoc() marked it:
   * undoes whatever the last keypress committed, then clears every one-shot the
   * sweep may have armed and re-asserts the slide + selection. EACH key must be
   * measured from the SAME state — the first draft let the checks run in sequence
   * and a leak masked the next one (Backspace deactivated the widget, after which
   * G had nothing to grab and its leak read as clean). Returns whether the
   * document is back to the mark. */
  const restore = (id, slide = 0) => page.evaluate(async (id, slide) => {
    const app = window.__powerrp_app;
    if (app.modalXform) app.modalCancel();
    if (app.crosshair) app.cancelCrosshair();
    app.paletteOpen = false;
    app.mode = "edit";
    // Present mode takes the page FULLSCREEN, which resizes the viewport: leaving
    // it behind moved every Inspector row out from under the coordinates a later
    // drag had already measured, and elementFromPoint returned nothing at all.
    if (document.fullscreenElement) await document.exitFullscreen();
    for (let i = 0; i < 10 && JSON.stringify(app.doc) !== window.__fieldProbeDoc; i++) app.undo();
    app.slideIndex = slide;
    app.selection = id;
    return JSON.stringify(app.doc) === window.__fieldProbeDoc && app.slideIndex === slide;
  }, id, slide);
  /** Command (in-page). Adds `type` at a known on-screen pose, selected. */
  const addItem = (type, pose) => page.evaluate((type, pose) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get(type).defaults);
    const id = app.selection;
    app.setPreview(Object.entries(pose).map(([k, v]) => [["items", id, k], v]));
    app.commitPreview();
    return id;
  }, type, pose);
  /** Query (in-page). Every Inspector scrubber, with the bounds it publishes —
   * `numericFieldBounded` (App.svelte's focus tracker) reads exactly these two
   * attributes, and DraggableNumber's Home/End branches exist exactly when it
   * was given both. */
  const scrubbers = () => page.evaluate(() => [...document.querySelectorAll('.inspector [role="spinbutton"]')].map((el) => ({
    label: el.getAttribute("aria-label"),
    min: el.getAttribute("aria-valuemin"),
    max: el.getAttribute("aria-valuemax"),
    value: el.getAttribute("aria-valuenow"),
  })));
  /** Command (in-page). Focuses the Inspector control matching `selector`;
   * returns whether it was found AND actually took focus. */
  const focusControl = (selector) => page.evaluate((selector) => {
    const el = document.querySelector(`.inspector ${selector}`);
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  }, selector);
  /** Query. The value an Inspector scrubber publishes, read off THE ELEMENT and
   * not off document.activeElement: a commit re-renders the Inspector, and a
   * re-render that replaces the node drops focus to <body>, whose aria-valuenow is
   * null — which reads as 0 and made two different drags compare equal. */
  const valueOf = (selector) => page.evaluate((selector) =>
    Number(document.querySelector(`.inspector ${selector}`)?.getAttribute("aria-valuenow")), selector);
  /** Command + query. Scrolls an Inspector control into view and returns its
   * page-space center. The scroll is NOT cosmetic: the property list is a scroll
   * container taller than the panel, so focusing a row further down leaves an
   * earlier row at a NEGATIVE y, where a mouse drag lands outside the viewport and
   * silently does nothing (measured: y = -246 for the first row). */
  const centerOf = (selector) => page.evaluate((selector) => {
    const el = document.querySelector(`.inspector ${selector}`);
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);

  // A rect: it carries the UNIVERSAL property rows, so both controls under test
  // are present — `opacity` (a bounded DraggableNumber) and `rotation` (the
  // AngleField dial).
  const id = await addItem("rect", { x: 360, y: 300, w: 220, h: 140 });
  ok(!!id, `added a rect and it is selected (id=${id})`);
  // Reported rather than thrown: a bare waitForSelector that times out here says
  // only "selector failed", and the interesting facts (did the item derive? is the
  // Inspector even showing item rows?) are exactly what the next check needs.
  const inspectorReady = await page.waitForSelector('.inspector [role="spinbutton"]', { timeout: 10000 }).then(() => true, () => false);
  ok(inspectorReady, `the Inspector rendered property rows for it (${JSON.stringify(await page.evaluate(() => {
    const app = window.__powerrp_app;
    return { sel: app.selection, nodes: app.nodes().length, slide: app.slideIndex,
      inspectorChars: document.querySelector(".inspector")?.textContent?.length ?? -1 };
  }))})`);
  await pause(300);

  const all = await scrubbers();
  ok(all.length > 0, `the Inspector shows scrubbers for the new rect (${all.length})`);
  const bounded = all.find((s) => s.min !== null && s.max !== null);
  ok(!!bounded, `at least one Inspector scrubber is BOUNDED, so Home/End have somewhere to jump (${JSON.stringify(all.map((s) => s.label))})`);
  const boundedSel = `[role="spinbutton"][aria-label="${bounded.label}"]`;
  // The fine-drag RATIO is measured on an UNBOUNDED row: on a bounded one a drag
  // long enough to clear the step grid also hits the clamp, and two saturated
  // values compare equal no matter what Shift did (measured — the first draft
  // read 1 and 1 on Opacity and called the ratio broken).
  const unbounded = all.find((s) => s.min === null && s.max === null);
  ok(!!unbounded, "at least one Inspector scrubber is UNBOUNDED, so a long drag cannot saturate");
  const unboundedSel = `[role="spinbutton"][aria-label="${unbounded.label}"]`;
  // The demo fixture's middle slide: Left AND Right both have somewhere to go
  // from here, so neither leak can hide behind a clamp at slide 0.
  const slideCount = await page.evaluate(() => window.__powerrp_app.doc.slides.length);
  ok(slideCount >= 3, `the fixture has a middle slide to sit on (${slideCount} slides)`);
  const homeSlide = 1;

  // ── 1. THE LEAKS: one keypress each, field focused, widget selected ────────
  // Each is a canvas command that must NOT fire from behind a focused field.
  // `Backspace` is the destructive one and the reason this probe exists.
  // `commits` names the keys THIS control legitimately writes a value on, so the
  // "committed nothing" assertion is not applied to them: the dial's arrow keys
  // ARE its own nudge (each one undo unit), while the scrubber reads only Up/Down
  // and so must leave the document alone on Left/Right.
  for (const control of [
    { name: "scrubber", selector: boundedSel, commits: [] },
    { name: "dial", selector: ".angle-dial", commits: ["ArrowLeft", "ArrowRight"] },
  ]) {
    await markDoc();
    const focused = await focusControl(control.selector);
    ok(focused, `the ${control.name} (${control.selector}) exists in the Inspector and takes focus`);
    if (!focused) continue;
    await pause(200);
    await shot(`10_${control.name}_focused`);
    const before = await snap(id);
    ok(before.sel === id && before.itemAlive, `${control.name}: the widget is selected and alive before the sweep (${JSON.stringify(before)})`);

    // key, the snapshot field it must not disturb, the value it must still hold,
    // and the command that would have fired.
    for (const [key, field, expected, what] of [
      ["Backspace", "itemAlive", true, "delete the widget"],
      ["Delete", "itemAlive", true, "delete the widget"],
      ["ArrowLeft", "slideIndex", homeSlide, "change slide"],
      ["ArrowRight", "slideIndex", homeSlide, "change slide"],
      ["KeyG", "modal", false, "start a modal grab"],
      ["KeyS", "modal", false, "start a modal scale"],
      ["KeyB", "crosshair", null, "arm box select"],
      ["KeyP", "mode", "edit", "enter present mode"],
      ["Space", "palette", false, "open the palette"],
    ]) {
      ok(await restore(id, homeSlide), `${control.name}: state restored to the mark before ${key}`);
      ok(await focusControl(control.selector), `${control.name}: re-focused before ${key}`);
      await pause(150);
      await page.keyboard.press(key);
      await pause(250);
      const s = await snap(id);
      ok(s[field] === expected, `${control.name}: ${key} did NOT ${what} (${field}=${JSON.stringify(s[field])}, expected ${JSON.stringify(expected)})`);
      if (!control.commits.includes(key)) ok(s.docIsBefore, `${control.name}: ${key} committed nothing to the document`);
    }
    await shot(`11_${control.name}_after_sweep`);
    ok(await restore(id, homeSlide), `${control.name}: the document is back at the mark after the sweep`);
  }

  // ── 2. THE FIELD'S OWN KEYS still work ────────────────────────────────────
  {
    ok(await restore(id), "state restored to the mark before the field's own keys");
    ok(await focusControl(boundedSel), `re-focused the bounded scrubber "${bounded.label}"`);
    await pause(150);
    const min = Number(bounded.min);
    const max = Number(bounded.max);

    await page.keyboard.press("Home");
    await pause(200);
    ok(await valueOf(boundedSel) === min, `Home jumps the bounded scrubber to its minimum (${min}, got ${await valueOf(boundedSel)})`);
    await page.keyboard.press("End");
    await pause(200);
    ok(await valueOf(boundedSel) === max, `End jumps the bounded scrubber to its maximum (${max}, got ${await valueOf(boundedSel)})`);

    // Arrow nudge: DOWN from the maximum must move, and by less than the range.
    const atMax = await valueOf(boundedSel);
    ok(await focusControl(boundedSel), "the bounded scrubber still has focus for the arrow nudge");
    await page.keyboard.press("ArrowDown");
    await pause(200);
    const nudged = await valueOf(boundedSel);
    ok(nudged < atMax && nudged >= min, `ArrowDown nudges the scrubber down one step (${atMax} → ${nudged})`);
    ok(await focusControl(boundedSel), "the bounded scrubber still has focus for the second arrow nudge");
    await page.keyboard.press("ArrowUp");
    await pause(200);
    ok(await valueOf(boundedSel) === atMax, `ArrowUp nudges it back (→ ${await valueOf(boundedSel)})`);

    /** Command. Drags the UNBOUNDED scrubber `dy` px (down is positive), optionally
     * with Shift held, and returns how far the value moved. The fallback (no
     * pointer lock) path is what headless gets — the component must be fully
     * functional without lock, which is also test_dn.js's standing assumption. */
    const dragBy = async (dy, fine) => {
      ok(await restore(id), `state restored before the ${fine ? "fine" : "coarse"} drag`);
      await pause(150);
      const from = await valueOf(unboundedSel);
      const c = await centerOf(unboundedSel);
      // The drag must actually LAND on the field. Asserted rather than assumed: a
      // leftover full-screen overlay swallows the pointer and the value simply
      // does not move, which reads exactly like a broken fine-drag multiplier.
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return {
          at: el === null ? null : el.closest('[role="spinbutton"]')?.getAttribute("aria-label") ?? `${el.tagName}.${el.className}`,
          point: [Math.round(x), Math.round(y)],
          viewport: [window.innerWidth, window.innerHeight],
          scroll: [window.scrollX, window.scrollY],
        };
      }, c);
      ok(hit.at === unbounded.label, `the ${fine ? "fine" : "coarse"} drag lands on "${unbounded.label}" (${JSON.stringify(hit)})`);
      if (fine) await page.keyboard.down("Shift");
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x, c.y + dy, { steps: 8 });
      await page.mouse.up();
      if (fine) await page.keyboard.up("Shift");
      await pause(250);
      const to = await valueOf(unboundedSel);
      console.log(`       (${fine ? "fine" : "coarse"} drag of ${dy}px on "${unbounded.label}": ${from} → ${to})`);
      return to - from;
    };
    const coarse = await dragBy(-DRAG_PX, false); // up = increase
    const fine = await dragBy(-DRAG_PX, true);
    ok(coarse > 0, `a ${DRAG_PX}px upward drag raises the value (${coarse})`);
    ok(fine > 0, `the same drag with Shift held also raises it (${fine})`);
    ok(fine < coarse, `Shift makes the drag FINER, not coarser (${fine} < ${coarse})`);
    // The exact multiplier, to a tolerance of one drag pixel's worth of value:
    // the result is snapped to the row's step grid, so an exact ratio is not
    // available even in principle.
    const perPixel = Math.abs(coarse) / DRAG_PX;
    ok(Math.abs(fine - coarse * FINE_FACTOR) <= perPixel * 1.5,
      `Shift-drag is ~${FINE_FACTOR}x the coarse drag (coarse ${coarse}, fine ${fine}, expected ~${coarse * FINE_FACTOR})`);
    await shot("20_field_own_keys");
  }

  // ── 3. WHAT MUST STILL BUBBLE ─────────────────────────────────────────────
  {
    // Cmd+Z: app undo LEGITIMATELY works while a field is focused, so the fix
    // must not have swallowed it. Measured against a marked document.
    await page.evaluate((id) => {
      const app = window.__powerrp_app;
      app.selection = id;
    }, id);
    await pause(150);
    await markDoc();
    await page.evaluate((id) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "x"], 555]]);
      app.commitPreview();
    }, id);
    await pause(200);
    ok(!(await snap(id)).docIsBefore, "a committed move advanced the document (the undo target exists)");
    ok(await focusControl(boundedSel), "re-focused the scrubber for the Cmd+Z check");
    await pause(150);
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Meta");
    await pause(250);
    const undone = await snap(id);
    ok(undone.docIsBefore, `Cmd+Z still reaches app undo from a focused field (docIsBefore=${undone.docIsBefore}, sel=${undone.sel})`);
    ok(undone.activeRole === "spinbutton", `the field kept focus across the undo (role=${undone.activeRole})`);

    // Escape belongs to the HOST above the control: web/NumericField.svelte's
    // wrapper claims it (revert the live preview + blur) and stopPropagations, so
    // a control that swallowed Escape itself would break its own wrapper. The
    // observable contract is that the selection survives — Escape must not fall
    // through to the registry's `deselect`.
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, id);
    await pause(150);
    ok(await focusControl(boundedSel), "re-focused the scrubber for the Escape check");
    await pause(150);
    const beforeEsc = await snap(id);
    ok(beforeEsc.sel === id, `the widget is selected before the Escape check (sel=${beforeEsc.sel})`);
    await page.keyboard.press("Escape");
    await pause(250);
    const esc = await snap(id);
    ok(esc.sel === id, `Escape on a focused scrubber does NOT deselect the widget (sel=${esc.sel})`);
    await shot("30_bubbling_keys");

    // THE INVARIANT THAT MAKES THE CLAIM SAFE, measured rather than assumed: a
    // canvas gesture MOVES focus off the field, so the field's keydown handler does
    // not run during a drag and cannot swallow the keys CanvasView reads for itself
    // from plain BUBBLE window listeners — held A for anchor snap, and the
    // Shift/Cmd/Alt drag-modifier trackers. If a gesture ever kept Inspector focus,
    // those would go dead while a field happened to be focused, and this check is
    // what would say so.
    //
    // It is measured for BOTH gesture kinds, and the focus ROLE is asserted rather
    // than merely "not the field": the destination is the canvas's PanZoom
    // container (`div[role=application]`, tabindex="-1"), which is what actually
    // takes the focus a pointerdown on the canvas moves. core/shortcut_entries.js
    // fieldFocus's docstring cites these two checks by name, so naming the
    // destination here is what keeps that citation checkable — and the reason its
    // earlier claim (a field "can hold focus through a canvas gesture") is recorded
    // there as measured false rather than quietly dropped.
    const APPLICATION_ROLE = "application";
    /** Query (in-page). Page-space point for a world coordinate, via the overlay's
     * own rect — the worldToScreen idiom every canvas-driving probe here uses. */
    const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
      const app = window.__powerrp_app;
      const s = app.canvasActions.worldToScreen(wx, wy);
      const rect = document.querySelector(".overlay").getBoundingClientRect();
      return { x: rect.left + s.x, y: rect.top + s.y };
    }, wx, wy);
    // RESIZE grabs a handle; MOVE grabs the item's own body (its world center, which
    // addItem placed at a known pose). Two different CanvasView entry points, so one
    // passing says nothing about the other.
    for (const gesture of [
      {
        name: "resize",
        at: async () => page.evaluate(() => {
          const el = document.querySelector(".resize-handle, .handle");
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }),
      },
      { name: "move", at: () => worldToPage(360 + 220 / 2, 300 + 140 / 2) },
    ]) {
      ok(await restore(id), `state restored before the ${gesture.name} gesture`);
      ok(await focusControl(boundedSel), `re-focused the scrubber before the ${gesture.name} gesture`);
      await pause(150);
      const from = await gesture.at();
      ok(!!from, `the selected widget offers a ${gesture.name} grab point (${JSON.stringify(from)})`);
      if (!from) continue;
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 });
      const mid = await snap(id);
      ok(mid.dragging, `the ${gesture.name} gesture is live (dragKind=${mid.dragKind})`);
      ok(mid.activeRole === APPLICATION_ROLE,
        `the ${gesture.name} gesture moved focus off the field onto the canvas container, so the field cannot swallow the canvas's own held-key reads (focus role=${mid.activeRole}, expected ${APPLICATION_ROLE})`);
      await page.mouse.up();
      await pause(200);
    }
    ok(await restore(id), "state restored after the canvas gestures");

    // AND THE OTHER HALF of the same docstring's claim: the takeovers fieldFocus
    // excludes ARE reachable with a field focused, which is why those exclusions
    // carry the load a blurred field cannot. Arming the band crosshair is a
    // command, not a canvas gesture, so nothing blurs the Inspector — the one-shot
    // arm survives, and Shift would then be announced twice (bandGesture's "Remove
    // from selection" and fieldFocus's "Fine adjust") if fieldFocus did not stand
    // down. Measured on the app's own state, not inferred from the predicates.
    {
      ok(await restore(id), "state restored before the armed-crosshair reachability check");
      await page.evaluate(() => window.__powerrp_app.runCommand("band-select-regular"));
      await pause(200);
      ok(await focusControl(boundedSel), "focused the scrubber while the band crosshair is armed");
      await pause(150);
      const armed = await snap(id);
      ok(armed.crosshair === "band" && armed.activeRole === "spinbutton",
        `an armed crosshair and a focused numeric field COEXIST (crosshair=${armed.crosshair}, focus role=${armed.activeRole}) — fieldFocus's !crosshairArmed exclusion is load-bearing, not decoration`);
      await page.evaluate(() => window.__powerrp_app.cancelCrosshair());
      await pause(150);
      ok(await restore(id), "state restored after the armed-crosshair reachability check");
    }
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  if (errors.length) { console.error(`\n${errors.length} FAILURES:\n` + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} field-key-ownership checks passed`);
} finally {
  await browser.close();
  await server.close();
}
