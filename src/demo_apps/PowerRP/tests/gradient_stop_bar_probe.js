/**
 * VISUAL GRADIENT STOP BAR probe — boot the PowerRP editor headless and drive the
 * REAL bar (web/GradientStopBar.svelte) with real pointer input, on BOTH kinds of
 * ramp list it is mounted for: a gradient PAINT's `stops` (reached through
 * web/PaintField.svelte) and the top-level `rampStops` (reached through
 * web/Inspector.svelte's own list row, which is the mount PaintField cannot see).
 *
 * Proves, against the REAL app:
 *   - THE BAR EXISTS where a ramp does, and NOWHERE ELSE: one bead per stop, on
 *     both ramp declarations, and NO bar on a polygon's `points` (a sequence of
 *     coordinates is not a ramp and has nothing to paint a track with).
 *   - A BEAD IS WHERE ITS STOP IS: bead x over the track maps to the stored
 *     offset, measured against the real client rects, not asserted from CSS.
 *   - A BEAD IS THE COLOUR IT REPRESENTS, AND POINTS AT ITS OWN STOP — the two
 *     halves of the user's 2026-08-02 ruling ("there's no reason to make them
 *     purple because that's not the color they're representing… they should have
 *     a tapered top so that they point to precisely where they are"). The fill is
 *     read back off the painted element and compared to the three DIFFERENT stop
 *     colours, so a single accent token could not pass it; the taper is asserted
 *     as a clip-path pentagon with its apex at the element's own centre-top.
 *   - THE ROWS STAY OPEN FOR THE WHOLE DRAG, sampled mid-gesture. A bead drag
 *     stages a whole-list preview, which is the shape ListField folds on, so the
 *     rows used to vanish for the duration; the user overruled that ("that
 *     actually makes things more confusing for me, not less confusing").
 *   - DRAG moves the stop, and is EXACTLY ONE undo unit — not one per
 *     pointermove, which is the single easiest thing to get wrong here.
 *   - DRAG PAST A NEIGHBOUR SWAPS, and the document is CANONICALLY ORDERED at
 *     every instant of the gesture — checked MID-DRAG, before the release,
 *     because that is when a leaf write would have left it broken.
 *   - PIXEL PROOF for that: the swapped result renders EXACTLY the hand-authored
 *     swapped gradient, and NOT the collapsed picture the same offsets written as
 *     a bare LEAF produce. Both comparisons are made, so neither is vacuous —
 *     core/lists.js's measured warning says an out-of-order stop "COLLAPSES its
 *     span instead of swapping", and this is that warning turned into a gate.
 *   - CLICK-TO-ADD lands a stop at the clicked position coloured with the ramp's
 *     OWN colour there, so the picture is PIXEL-IDENTICAL before and after —
 *     adding a stop must change nothing until you change its colour.
 *   - AN EQUATION-BOUND POSITION IS NOT DRAGGABLE: the bead is marked, reports
 *     aria-disabled, a full drag gesture on it leaves the document BYTE-IDENTICAL
 *     (the expression is never stamped over with a literal), and its neighbours
 *     still drag — with the expression surviving the reorder.
 *   - TWO STOPS AT ONE POSITION is legal (a hard colour edge) and the tie is
 *     stable, so the bead being held does not leapfrog one it merely reached.
 *   - PURGE removes the selected stop as one undo unit and REFUSES at the
 *     declared two-stop floor, with the reason in its tooltip rather than going
 *     quietly inert.
 *   - SELECTING a bead lights up the ROW that edits that stop's colour.
 *
 * Writes screenshots to POWERRP/.claude_vlm_checks/gradient_stop_bar/.
 *
 * Run from anywhere: node src/demo_apps/PowerRP/tests/gradient_stop_bar_probe.js
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { PNG } from "pngjs";
import { launchBrowser } from "./puppeteerLaunch.js";

// puppeteer >= 23 returns screenshot bytes as a Uint8Array; pngjs wants a real
// Buffer (tests/filmstrip_live_probe.js's own note).
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

/**
 * Pure function. The WORST per-channel difference between two same-size RGBA
 * rasters, and how many pixels differ at all — the measured form of "these two
 * renders agree", where byte-equality is too strong a claim to make.
 *
 * @param {{width:number,height:number,data:Uint8Array}} a
 * @param {{width:number,height:number,data:Uint8Array}} b
 * @returns {{maxDelta:number, differing:number, total:number}}
 *
 * @example // rasterDelta(sameImage, sameImage) → {maxDelta: 0, differing: 0, total: 12345}
 * @example // a render whose only change is one 8-bit rounding step → {maxDelta: 1, differing: 900, …}
 */
function rasterDelta(a, b) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`rasterDelta: ${a.width}x${a.height} vs ${b.width}x${b.height} — nothing to compare`);
  let maxDelta = 0, differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let worst = 0;
    for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(a.data[i + k] - b.data[i + k]));
    if (worst > 0) differing++;
    maxDelta = Math.max(maxDelta, worst);
  }
  return { maxDelta, differing, total: a.width * a.height };
}

// Paths resolve off THIS file, never process.cwd() — the suite convention
// (tests/probe_artifact_path_test.js enforces it).
const HERE = dirname(fileURLToPath(import.meta.url));
const powerrp = resolve(HERE, "..");
const webRoot = resolve(powerrp, "web");
const shots = resolve(powerrp, ".claude_vlm_checks/gradient_stop_bar");
await mkdir(shots, { recursive: true });
const demoJson = await readFile(resolve(powerrp, "examples/demo.powerrp.json"), "utf8");

// hmr: false / watch: null — this probe drives a long stateful sequence, and a
// hot update from any editor save anywhere in the tree reloads the page mid-run
// (tests/list_ui_probe.js's own reason, measured as "Execution context was
// destroyed" while sibling agents were saving).
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The stale-fixture boot-noise allowance tests/list_ui_probe.js documents: other
// agents' in-flight migrations of the shared demo fixture, plus this container's
// headless graphics reality. Named specifically — anything else still fails.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// The gradient rect's world box — one place, because the pixel clip and the item
// creation must describe the same rectangle.
const BOX = { x: 760, y: 260, w: 320, h: 200 };
const RED = "#ff0000", GREEN = "#00ff00", BLUE = "#0000ff";
const THREE = [{ offset: 0, color: RED }, { offset: 0.5, color: GREEN }, { offset: 1, color: BLUE }];
/** The list a DRAG of the red stop to 0.8 must produce — hand-authored, so the
 *  pixel compare is against a value nothing in the bar computed. */
const SWAPPED = [{ offset: 0.5, color: GREEN }, { offset: 0.8, color: RED }, { offset: 1, color: BLUE }];
/** The SAME offsets written as a bare leaf (what scrubbing the row's own `offset`
 *  field does): descending at the head, the state that collapses. */
const LEAF_WRITTEN = [{ offset: 0.8, color: RED }, { offset: 0.5, color: GREEN }, { offset: 1, color: BLUE }];
/** How close a measured bead centre must sit to its predicted x, in CSS px. One
 *  device pixel of layout rounding is expected; anything more is a mapping bug. */
const BEAD_X_TOLERANCE_PX = 1.5;
/** How close a dragged stop must land to the fraction the pointer was over. The
 *  pointer lands on an integer device pixel, so the fraction it names is quantized
 *  by 1/trackWidth; a ~300px track makes that ~0.004. */
const DRAG_OFFSET_TOLERANCE = 0.01;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await settle(700);
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  // ── Page helpers (tests/list_ui_probe.js's, verbatim where they overlap) ────
  // EVERY array read out of the page goes through JSON: a Svelte $state proxy
  // array serializes over CDP as a plain OBJECT, silently losing .length.
  const jsonEval = (fn, ...args) => page.evaluate(fn, ...args).then((s) => JSON.parse(s));
  const stateAt = (id, keys) => jsonEval((id, keys) => {
    let v = window.__powerrp_app.state().items?.[id];
    for (const k of keys) v = v?.[k];
    return JSON.stringify(v ?? null);
  }, id, keys);
  const rawAt = (id, keys) => jsonEval((id, keys) => {
    let v = window.__powerrp_app.rawState().items?.[id];
    for (const k of keys) v = v?.[k];
    return JSON.stringify(v ?? null);
  }, id, keys);
  const docJson = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const stops = (id) => stateAt(id, ["fill", "linear", "stops"]);
  const offsetsOf = async (id) => (await stops(id)).map((s) => s.offset);
  const colorsOf = async (id) => (await stops(id)).map((s) => s.color);

  /** The bar's own geometry, straight off the client rects — the track box and
   *  every bead's centre, so "the bead is where the stop is" is MEASURED. */
  const barGeometry = () => jsonEval(() => {
    const track = document.querySelector(".stopbar-track");
    if (!track) return JSON.stringify(null);
    const t = track.getBoundingClientRect();
    const beads = [...document.querySelectorAll(".stopbar-bead")].map((b) => {
      const r = b.getBoundingClientRect();
      // `fill` is the COMPUTED --sb-bead on the fill layer, i.e. exactly the colour
      // that element is painted; `apexTop` and `bodyTop` bracket the TAPER, which is
      // what makes the pin point at anything. Read from the inner .stopbar-bead-fill
      // rather than the button, because that is the element carrying the colour.
      const fillEl = b.querySelector(".stopbar-bead-fill");
      const cs = fillEl ? getComputedStyle(fillEl) : null;
      return {
        cx: r.left + r.width / 2, cy: r.top + r.height / 2, right: r.right,
        w: r.width, h: r.height,
        fill: cs ? cs.getPropertyValue("--sb-bead").trim() : null,
        clip: cs ? cs.clipPath : null,
        bound: b.classList.contains("stopbar-bead-bound"), selected: b.classList.contains("selected"),
        ariaDisabled: b.getAttribute("aria-disabled"), valuenow: Number(b.getAttribute("aria-valuenow")),
      };
    });
    const p = document.querySelector(".stopbar-purge").getBoundingClientRect();
    return JSON.stringify({ track: { left: t.left, top: t.top, right: t.right, width: t.width, height: t.height }, beads, purge: { left: p.left, right: p.right, top: p.top, bottom: p.bottom } });
  });
  /** Scrolls the bar into the Inspector's viewport, so client rects are real. */
  const revealBar = async () => {
    await page.evaluate(() => document.querySelector(".stopbar")?.scrollIntoView({ block: "center" }));
    await settle(150);
  };
  /** A full press → N moves → release over the track, in CSS px. Real CDP input,
   *  so pointer capture and the component's own handlers do the work. */
  const dragTo = async (fromX, y, toX, { steps = 6, midway = null } = {}) => {
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
      await settle(20);
      if (midway && i === Math.ceil(steps / 2)) await midway();
    }
    await page.mouse.up();
    await settle(200);
  };
  /** Runs `action`, then proves the document takes EXACTLY ONE undo to restore. */
  const oneUndoUnit = async (label, action) => {
    const before = await docJson();
    await action();
    await settle();
    const after = await docJson();
    ok(after !== before, `${label}: really changed the document (the undo check is not vacuous)`);
    await page.evaluate(() => window.__powerrp_app.undo());
    await settle(80);
    ok(await docJson() === before, `${label}: EXACTLY ONE undo unit (JSON compare)`);
    await page.evaluate(() => window.__powerrp_app.redo());
    await settle(80);
    ok(await docJson() === after, `${label}: redo restores it (a single unit both ways)`);
  };
  // `reveal` scrolls the bar into view first — which MOVES it, so a shot that is
  // measuring something the POINTER is doing must pass false or the scroll fires
  // pointerleave and photographs the rest state instead.
  const shotOfBar = async (name, { reveal = true } = {}) => {
    if (reveal) await revealBar();
    const clip = await page.evaluate(() => {
      const r = document.querySelector(".ramp-presets-and-list").getBoundingClientRect();
      const PAD = 8;
      return { x: Math.max(0, Math.round(r.x) - PAD), y: Math.max(0, Math.round(r.y) - PAD), width: Math.round(r.width) + 2 * PAD, height: Math.round(r.height) + 2 * PAD };
    });
    await page.screenshot({ path: resolve(shots, `${name}.png`), clip });
  };

  // ── The gradient rect under test ───────────────────────────────────────────
  const setStops = (id, list) => page.evaluate((id, list) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill"], { type: "linearGradient", solid: "#ff0000", linear: { stops: list, angle: 0 }, radial: { stops: list, center: { x: 0.5, y: 0.5 }, r: 0.5 } }]]);
    app.commitPreview();
  }, id, list);

  const rectId = await page.evaluate((box) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("rect").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], box.x], [["items", id, "y"], box.y],
      [["items", id, "w"], box.w], [["items", id, "h"], box.h],
      [["items", id, "strokeWidth"], 0],
    ]);
    app.commitPreview();
    return id;
  }, BOX);
  await setStops(rectId, THREE);
  await settle(350);
  await revealBar();

  // ── 1. THE BAR RENDERS, WITH ONE BEAD PER STOP ─────────────────────────────
  ok(await page.evaluate(() => !!document.querySelector(".ramp-presets-and-list .stopbar")),
    "a gradient's stops get the VISUAL BAR, mounted in the list wrapper beside the preset library");
  ok(await page.evaluate(() => {
    const wrap = document.querySelector(".ramp-presets-and-list");
    const kids = [...wrap.children].map((c) => c.className);
    return kids.indexOf("stopbar") < kids.indexOf("listfield");
  }), "the bar sits ABOVE the rows (they are live under it during a drag; from below it would move under the pointer)");
  {
    const geo = await barGeometry();
    // A missing bar must report a SENTENCE, not a stack: this is the check that
    // is red when the feature is absent (proven in a detached worktree at HEAD),
    // and a null-dereference there reads like a broken probe rather than a
    // missing control.
    ok(geo !== null, "the bar is mounted at all (no .stopbar-track means the feature is absent, not that the probe is broken)");
    if (geo === null) throw new Error("gradient_stop_bar_probe: no stop bar to measure — see the check above");
    ok(geo.beads.length === 3, `one bead per stop (${geo.beads.length})`);
    ok(geo.track.width > 0, `the track has a real width (${geo.track.width})`);
    // THE MAPPING, MEASURED: bead centre x == track.left + offset * track.width.
    const expected = THREE.map((s) => geo.track.left + s.offset * geo.track.width);
    const worst = Math.max(...geo.beads.map((b, i) => Math.abs(b.cx - expected[i])));
    ok(worst <= BEAD_X_TOLERANCE_PX, `every bead sits at its stop's position on the track (worst error ${worst.toFixed(2)}px)`);
    ok(geo.beads.every((b) => !b.bound), "no stop is equation-bound yet, so no bead wears the ƒ mark");
    // ── EACH BEAD IS THE COLOUR IT REPRESENTS (user ruling 2026-08-02) ────────
    // "there's no reason to make them purple because that's not the color
    // they're representing. They should be the color they're representing." The
    // bead used to be one flat accent fill for every stop; --sb-bead is now the
    // stop's own evaluated colour, and this reads it back off the painted element.
    // The check is NOT vacuous by construction: THREE holds three DIFFERENT
    // colours, so a token fill would collapse all three onto one value.
    ok(JSON.stringify(geo.beads.map((b) => b.fill)) === JSON.stringify(THREE.map((s) => s.color)),
      `each bead is painted its own stop's colour (${JSON.stringify(geo.beads.map((b) => b.fill))})`);
    ok(new Set(geo.beads.map((b) => b.fill)).size === THREE.length,
      "…and the three differ, so this could not pass with a single accent token");
    // ── AND IT POINTS AT ITS STOP ────────────────────────────────────────────
    // "they should have a tapered top so that they point to precisely where they
    // are… instead of being a box with a flat top." The taper is a clip-path
    // pentagon with its apex at 50% 0 — dead centre of the element's top edge,
    // which translateX(-50%) has already put on the stop's fraction. Asserted on
    // the computed clip rather than a screenshot so the failure names the cause.
    ok(geo.beads.every((b) => /polygon/.test(b.clip ?? "") && /50%\s+0/.test(b.clip ?? "")),
      `every bead is clipped to a pin whose apex is at its own centre-top (${JSON.stringify(geo.beads[0].clip)})`);
    ok(geo.beads.every((b) => b.h > b.w),
      `…and is taller than it is wide, so the taper has room to be one (${geo.beads[0].w}x${geo.beads[0].h})`);
    // NOTHING OVERLAPS THE END BEADS. A bead at position 0 or 1 is centred on the
    // track's very edge and overhangs it by half its width, which is WIDER than a
    // spacing step — so the trailing purge button collides with the last bead
    // unless the column gap is at least that overhang. Measured rather than
    // eyeballed: it looked fine at --a-sp-2 and was not.
    const lastBeadRight = Math.max(...geo.beads.map((b) => b.right));
    ok(geo.purge.left >= lastBeadRight,
      `the purge button clears the bead at position 1 (button left ${geo.purge.left.toFixed(1)} vs bead right ${lastBeadRight.toFixed(1)})`);
    ok(geo.purge.left >= geo.track.right, "…and it never sits over the ramp itself");
  }
  await shotOfBar("bar_three_stops");

  // ── 1b. THE GHOST: where a click would land, said WITHOUT a document write ──
  {
    const geo = await barGeometry();
    const before = await docJson();
    await page.mouse.move(geo.track.left + 0.32 * geo.track.width, geo.track.top + geo.track.height / 2);
    await settle(250);
    // The tooltip must state the POSITION, not the resting sentence — the text has
    // to track the pointer or it is describing a click somewhere else.
    ok(/Add a stop at 0\.3/.test(await page.evaluate(() => document.querySelector(".tooltip, [role=tooltip]")?.textContent ?? "")),
      `the tip states WHERE the click would land and what colour it would take (${await page.evaluate(() => document.querySelector(".tooltip, [role=tooltip]")?.textContent ?? "<no tip>")})`);
    ok(await page.evaluate(() => !!document.querySelector(".stopbar-ghost")), "hovering the track shows a GHOST at the pointer");
    ok(await docJson() === before,
      "…and stages NOTHING: the ghost is pure UI, so the rows below cannot resize under the pointer (why the hover-PREVIEW trope is withheld here)");
    ok(await page.evaluate(() => document.querySelectorAll(".listfield .list-el").length) === 3,
      "the rows are still open while hovering — nothing is staged, so nothing folds them");
    await shotOfBar("bar_hover_ghost", { reveal: false });
    await page.mouse.move(0, 0);
    await settle(120);
    ok(await page.evaluate(() => !document.querySelector(".stopbar-ghost")), "leaving the track takes the ghost with it");
  }

  // ── 1c. A TRANSLUCENT RAMP reads as translucent (the alpha checkerboard) ────
  {
    await setStops(rectId, [{ offset: 0, color: "#ff000000" }, { offset: 1, color: BLUE }]);
    await settle(250);
    await revealBar();
    ok(await page.evaluate(() => {
      const bg = getComputedStyle(document.querySelector(".stopbar-track")).backgroundImage;
      return /repeating-conic-gradient/.test(bg) && /linear-gradient/.test(bg);
    }), "the track paints the ramp OVER the transparency checkerboard, so a fade-out reads as a fade-out and not as a fade to black");
    await shotOfBar("bar_translucent_ramp");
    await setStops(rectId, THREE);
    await settle(250);
    await revealBar();
  }

  // ── 2. DRAG: one stop moves, ONE undo unit ─────────────────────────────────
  {
    const geo = await barGeometry();
    const y = geo.beads[1].cy;
    const target = geo.track.left + 0.25 * geo.track.width;
    await oneUndoUnit("bead drag", () => dragTo(geo.beads[1].cx, y, target));
    const os = await offsetsOf(rectId);
    ok(Math.abs(os[1] - 0.25) < DRAG_OFFSET_TOLERANCE, `the dragged stop landed where the pointer did (${JSON.stringify(os)})`);
    ok(JSON.stringify(await colorsOf(rectId)) === JSON.stringify([RED, GREEN, BLUE]), "no reorder, so the colours are untouched");
  }
  await shotOfBar("bar_after_drag");

  // ── 3. DRAG PAST A NEIGHBOUR: it SWAPS, and stays ordered MID-GESTURE ───────
  await setStops(rectId, THREE);
  await settle(250);
  await revealBar();
  {
    const geo = await barGeometry();
    const midChecks = [];
    // THE ROWS STAY UP FOR THE WHOLE GESTURE — user ruling 2026-08-02, verbatim:
    // "the submenu for stops disappears as I drag it and reappears when I'm done.
    // Please, you don't need to do that. That actually makes things more confusing
    // for me, not less confusing." A bead drag stages a whole-list preview, which
    // is the shape ListField folds on, so this used to render ZERO rows for the
    // duration. The bar now declares its gesture (`ondrag`) and ListField exempts
    // it. Sampled at the same instants as the ordering check, so a fold anywhere
    // in the gesture is caught rather than only its endpoints.
    const midRows = [];
    await dragTo(geo.beads[0].cx, geo.beads[0].cy, geo.track.left + 0.8 * geo.track.width, {
      steps: 8,
      midway: async () => {
        const os = (await stops(rectId)).map((s) => s.offset);
        midChecks.push(os.every((o, i) => i === 0 || os[i - 1] <= o));
        midRows.push(await page.evaluate(() => document.querySelectorAll(".listfield .list-el").length));
      },
    });
    ok(midChecks.length > 0 && midChecks.every(Boolean),
      `MID-DRAG the document is canonically ordered (${midChecks.length} sample(s)) — a leaf write would have left it collapsed here`);
    ok(midRows.length > 0 && midRows.every((n) => n === THREE.length),
      `MID-DRAG the stop ROWS stay open and show the previewed list (${JSON.stringify(midRows)}) — the fold the user overruled would read as all zeroes here`);
    const os = await offsetsOf(rectId);
    ok(os.every((o, i) => i === 0 || os[i - 1] <= o), `after the release the offsets ascend (${JSON.stringify(os)})`);
    ok(JSON.stringify(await colorsOf(rectId)) === JSON.stringify([GREEN, RED, BLUE]),
      `dragging past a neighbour SWAPPED the two stops (${JSON.stringify(await colorsOf(rectId))})`);
    const geoAfter = await barGeometry();
    ok(geoAfter.beads[1].selected, "the bead the user was holding is still the selected one, at its NEW address");
  }
  await shotOfBar("bar_after_swap");

  // ── 4. PIXEL PROOF: the swap renders the swap, not the collapse ────────────
  // Deselect first, so no selection overlay lands inside the compared clip.
  const clipOf = () => page.evaluate((box) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(box.x, box.y);
    const e = app.canvasActions.worldToScreen(box.x + box.w, box.y + box.h);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    // Inset by two pixels so an antialiased edge cannot decide the compare, then
    // INTERSECT with the canvas — a clip that spilled onto panel chrome would
    // photograph static pixels that dilute what is being compared.
    const b = { x0: Math.round(rect.left + s.x) + 2, y0: Math.round(rect.top + s.y) + 2, x1: Math.round(rect.left + e.x) - 2, y1: Math.round(rect.top + e.y) - 2 };
    const c = document.querySelector("canvas").getBoundingClientRect();
    const x0 = Math.max(b.x0, Math.ceil(c.left)), y0 = Math.max(b.y0, Math.ceil(c.top));
    const x1 = Math.min(b.x1, Math.floor(c.right)), y1 = Math.min(b.y1, Math.floor(c.bottom));
    if (!(x1 > x0 && y1 > y0)) throw new Error("the gradient rect is not visible on the canvas — nothing to compare");
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }, BOX);
  const shoot = async (name) => {
    const clip = await clipOf();
    const buf = await page.screenshot({ clip });
    await writeFile(resolve(shots, `${name}.png`), buf);
    return buf;
  };
  const deselect = async () => { await page.evaluate(() => { window.__powerrp_app.selection = null; }); await settle(300); };
  {
    // What the bar just produced, rendered.
    await deselect();
    const draggedShot = await shoot("render_dragged_swap");
    // The hand-authored swap, rendered.
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
    await settle(150);
    await setStops(rectId, SWAPPED);
    await deselect();
    const authoredShot = await shoot("render_authored_swap");
    // The same offsets written as a bare LEAF — the collapsed picture.
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
    await settle(150);
    await setStops(rectId, LEAF_WRITTEN);
    await deselect();
    const collapsedShot = await shoot("render_leaf_written_collapse");

    ok(!authoredShot.equals(collapsedShot),
      "the compare is NOT vacuous: the ordered list and the leaf-written one render DIFFERENTLY (the measured collapse)");
    ok(draggedShot.equals(authoredShot),
      `PIXEL PROOF: a drag past a neighbour renders EXACTLY the hand-authored swap (${draggedShot.length} vs ${authoredShot.length} bytes)`);
  }

  // ── 5. CLICK-TO-ADD changes the picture by NOTHING ─────────────────────────
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
  await settle(150);
  await setStops(rectId, THREE);
  await settle(250);
  await revealBar();
  {
    await deselect();
    const beforeShot = await shoot("render_before_add");
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
    await settle(250);
    await revealBar();
    const geo = await barGeometry();
    const at = 0.75;
    await oneUndoUnit("click-to-add", async () => {
      await page.mouse.click(geo.track.left + at * geo.track.width, geo.track.top + geo.track.height / 2);
      await settle(200);
    });
    const list = await stops(rectId);
    ok(list.length === 4, `clicking the track added a stop (${list.length} stops)`);
    const added = list.find((s) => Math.abs(s.offset - at) < DRAG_OFFSET_TOLERANCE);
    ok(!!added, `the new stop is at the clicked position (${JSON.stringify(list.map((s) => s.offset))})`);
    // Its colour is the ramp's OWN colour there, and this expectation is
    // HAND-COMPUTED rather than taken from the sampler the component calls, so
    // the check is not the component agreeing with itself: 0.75 sits exactly
    // halfway along the green→blue leg (0.5 → 1), and (0,255,0) blended with
    // (0,0,255) at a half is (0, 127.5, 127.5) → #008080.
    ok(added && String(added.color).toLowerCase() === "#008080",
      `and it took the ramp's own colour there — the hand-computed midpoint (got ${added && added.color})`);
    await deselect();
    const afterShot = await shoot("render_after_add");
    // ADDING A STOP MUST NOT CHANGE THE PICTURE — measured, and bounded at ONE
    // 8-bit step rather than claimed as byte-identity, because it CANNOT be
    // byte-identical and saying so would be a false gate: the sampled colour has
    // to be stored as a hex, so the exact 127.5 the ramp passed through is pinned
    // at 128. That is the only difference there is, and this measures that it is
    // the only one.
    const addDelta = rasterDelta(readPng(beforeShot), readPng(afterShot));
    ok(addDelta.maxDelta <= 1,
      `PIXEL PROOF: adding a stop on the ramp changes the picture by at most one 8-bit quantization step (worst channel delta ${addDelta.maxDelta}, ${addDelta.differing}/${addDelta.total} px differ at all)`);
    // …and the bound is not vacuous: recolouring that same stop moves the picture
    // by far more, so a real change would have been caught.
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
    await settle(150);
    await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const list = JSON.parse(JSON.stringify(app.state().items[id].fill.linear.stops));
      list[2] = { ...list[2], color: "#ff00ff" };
      app.setPreview([[["items", id, "fill", "linear", "stops"], list]]);
      app.commitPreview();
    }, rectId);
    await deselect();
    const recolouredShot = await shoot("render_after_add_recoloured");
    const recolourDelta = rasterDelta(readPng(beforeShot), readPng(recolouredShot));
    ok(recolourDelta.maxDelta > 1,
      `the one-step bound is NOT vacuous: recolouring that stop moves the picture by ${recolourDelta.maxDelta}`);
  }
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rectId);
  await settle(250);
  await revealBar();
  await shotOfBar("bar_after_add");

  // ── 6. AN EQUATION-BOUND POSITION IS NOT DRAGGABLE ─────────────────────────
  await setStops(rectId, THREE);
  await settle(250);
  // Bind stop 1's offset to an expression that REFERENCES something, so it is a
  // real equation rather than a number the field would fold to a literal.
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill", "linear", "stops", 1, "offset"], "self.w / 800"]]);
    app.commitPreview();
  }, rectId);
  await settle(300);
  await revealBar();
  {
    const raw = await rawAt(rectId, ["fill", "linear", "stops", 1, "offset"]);
    ok(typeof raw === "string", `the bound stop stores an EXPRESSION (${JSON.stringify(raw)})`);
    ok(await stateAt(rectId, ["fill", "linear", "stops", 1, "offset"]) === BOX.w / 800,
      "and core evaluates it (320 / 800 = 0.4)");
    const geo = await barGeometry();
    ok(geo.beads[1].bound, "its bead wears the ƒ mark");
    ok(geo.beads[1].ariaDisabled === "true", "and reports aria-disabled, so it does not advertise a grab it will refuse");
    const expectedX = geo.track.left + (BOX.w / 800) * geo.track.width;
    ok(Math.abs(geo.beads[1].cx - expectedX) <= BEAD_X_TOLERANCE_PX,
      `the bead is drawn where the expression EVALUATES (${geo.beads[1].cx.toFixed(1)} vs ${expectedX.toFixed(1)})`);

    // THE DRAG THAT MUST DO NOTHING.
    const before = await docJson();
    await dragTo(geo.beads[1].cx, geo.beads[1].cy, geo.track.left + 0.9 * geo.track.width);
    ok(await docJson() === before, "a full drag gesture on it leaves the document BYTE-IDENTICAL — the expression is never stamped over");
    ok(await rawAt(rectId, ["fill", "linear", "stops", 1, "offset"]) === raw, "the expression is still the stored value");

    // …while its NEIGHBOUR still drags, past it, expression intact.
    const geo2 = await barGeometry();
    await dragTo(geo2.beads[0].cx, geo2.beads[0].cy, geo2.track.left + 0.7 * geo2.track.width);
    const rawList = await rawAt(rectId, ["fill", "linear", "stops"]);
    ok(rawList.some((s) => s.offset === raw), `the equation survived a REORDER around it (${JSON.stringify(rawList.map((s) => s.offset))})`);
    const os = await offsetsOf(rectId);
    ok(os.every((o, i) => i === 0 || os[i - 1] <= o), `and the list is still ordered by the EVALUATED positions (${JSON.stringify(os)})`);
  }
  await shotOfBar("bar_equation_bound");

  // ── 7. TWO STOPS AT ONE POSITION (a hard edge) ─────────────────────────────
  await setStops(rectId, THREE);
  await settle(250);
  await revealBar();
  {
    const geo = await barGeometry();
    await dragTo(geo.beads[1].cx, geo.beads[1].cy, geo.beads[0].cx);
    const os = await offsetsOf(rectId);
    ok(os.length === 3, `both stops are still stored (${JSON.stringify(os)})`);
    ok(Math.abs(os[0] - os[1]) < DRAG_OFFSET_TOLERANCE, "two stops may share a position — a hard colour edge");
    ok(JSON.stringify(await colorsOf(rectId)) === JSON.stringify([RED, GREEN, BLUE]),
      "and the tie is STABLE: the bead being held did not leapfrog the one it merely reached");
  }
  await shotOfBar("bar_coincident_stops");

  // ── 8. SELECTION LIGHTS THE ROW; PURGE REMOVES AND REFUSES ─────────────────
  await setStops(rectId, THREE);
  await settle(250);
  await revealBar();
  {
    const geo = await barGeometry();
    await page.mouse.click(geo.beads[2].cx, geo.beads[2].cy);
    await settle(150);
    ok(await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".listfield .list-el")];
      return rows.findIndex((r) => r.classList.contains("list-el-selected"));
    }) === 2, "clicking a bead lights up the ROW that edits that stop's colour");
    await shotOfBar("bar_selected_stop");

    ok(await page.evaluate(() => document.querySelector(".stopbar-purge").getAttribute("aria-disabled")) === "false",
      "with 3 stops (above the declared minimum of 2) the bar's purge is available");
    await oneUndoUnit("bar purge", async () => {
      await page.evaluate(() => document.querySelector(".stopbar-purge").click());
      await settle(200);
    });
    ok((await stops(rectId)).length === 2, `purge removed the selected stop (${(await stops(rectId)).length} left)`);

    const purge = await jsonEval(() => {
      const b = document.querySelector(".stopbar-purge");
      return JSON.stringify({ disabled: b.getAttribute("aria-disabled"), focusable: b.tabIndex >= 0 || !b.hasAttribute("disabled") });
    });
    ok(purge.disabled === "true", "at the two-stop floor it REFUSES");
    ok(purge.focusable, "…as aria-disabled, so the keyboard can still reach the tooltip that says why");
    const before = await docJson();
    await page.evaluate(() => document.querySelector(".stopbar-purge").click());
    await settle(200);
    ok(await docJson() === before, "and a click on the refusing button writes nothing");
  }
  await shotOfBar("bar_two_stop_floor");

  // ── 9. THE THIRD MOUNT POINT: `rampStops`, which PaintField never sees ─────
  {
    const mandelId = await page.evaluate(() => {
      const app = window.__powerrp_app;
      app.addItem(app.registry.get("demo_mandelbrot").defaults);
      return app.selection;
    });
    await settle(400);
    await page.evaluate(() => {
      // The ramp row lives in a category that may be folded; open every one so the
      // list (and its bar) is mounted.
      for (const h of document.querySelectorAll(".inspector .cat-header[aria-expanded=false]")) h.click();
    });
    await settle(300);
    const bars = await page.evaluate(() => document.querySelectorAll(".stopbar").length);
    ok(bars >= 1, `the Mandelbrot RAMP gets the bar too, through the Inspector's own list row (${bars} bar(s))`);
    ok(await page.evaluate(() => document.querySelectorAll(".stopbar-bead").length) > 0,
      "…with its own beads — this is the mount web/PaintField.svelte cannot reach");
    await shotOfBar("bar_ramp_stops");
    await page.evaluate((id) => { window.__powerrp_app.purgeItem?.(id) ?? (window.__powerrp_app.selection = null); }, mandelId);
    await settle(200);
  }

  // ── 10. NO BAR WHERE THERE IS NO RAMP ──────────────────────────────────────
  {
    const polyId = await page.evaluate(() => {
      const app = window.__powerrp_app;
      app.addItem(app.registry.get("polygon").defaults);
      const id = app.selection;
      app.setPreview([[["items", id, "points"], [[0, 0], [1, 0], [1, 1], [0, 1]]]]);
      app.commitPreview();
      return id;
    });
    await settle(400);
    ok(await page.evaluate(() => !!document.querySelector(".inspector .row.row-list .listfield")),
      "the polygon's points still render the list control");
    ok(await page.evaluate(() => document.querySelectorAll(".inspector .row.row-list .stopbar").length) === 0,
      "…and NO stop bar: a sequence of coordinates is not a ramp and has no track to paint");
    void polyId;
  }

  ok(liveErrors.length === 0, `no console errors during the run (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass).length;
for (const [pass, label] of checks) console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\ngradient_stop_bar_probe: ${checks.length - failed}/${checks.length} checks, screenshots in ${shots}`);
if (failed > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
