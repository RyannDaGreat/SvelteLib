/**
 * R6-28 EQUATION LOCK — the BROWSER half: real pointer drags, in the real editor.
 *
 * ── WHY A PROBE AND NOT JUST THE NODE SUITE ──────────────────────────────────
 * tests/equation_lock_test.js proves the PROJECTION: hand a seam function a
 * pinning and the locked key is absent from the pairs. It cannot prove the thing
 * a user actually cares about — that the nine drag paths in CanvasView reach that
 * seam WITH the projection, that the toolbar toggle is wired to the app state the
 * seam reads, and that a real `pointerdown → move → up` therefore leaves the
 * equation STRING in the document. A missing argument at one call site passes
 * every bare-node test in this repo and ships a feature that silently does
 * nothing on that gesture.
 *
 * ── THE ASSERTION IS ON THE STORED STRING, NOT ON THE NUMBER ─────────────────
 * `y` unchanged is NOT the property. A drag that rewrites `y` with the number its
 * equation currently evaluates to leaves the identical picture and has destroyed
 * the binding. So every check here reads the RAW stored value and asserts it is
 * still the `=` string. The unlocked control scenario is what makes that
 * meaningful: the SAME drag, lock off, must turn it into a number — otherwise the
 * check would pass on an app where drags do nothing at all.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/equation_lock_probe.js
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

// A PRIVATE DEP CACHE + no HMR + no watcher, adopting tests/scene3d_probe.js's
// measured rationale rather than re-deriving it: the default cache is the shared
// `node_modules/.vite`, every concurrently running agent's dev server writes it,
// and a peer's re-optimize rotates the `?v=` hash under this page's in-flight
// imports. MEASURED HERE TOO, on the run that prompted this: an untouched
// existing probe (modifier_probe) failed with the identical 30 s navigation
// timeout at the same moment, which is how the environment was ruled in and this
// suite ruled out. One extra re-optimize per run buys an attributable result.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  cacheDir: await mkdtemp(join(tmpdir(), "powerrp-eqlock-vite-")),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser({ protocolTimeout: 180000 });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// The same stale-fixture / headless-graphics boot noise every canvas probe in
// this directory allowlists (documented in concerns.md): other agents' in-flight
// migrations on the shared demo fixture, and the demo's video widgets probing for
// an adapter the software renderer does not expose. Named specifically — the gate
// still fails on anything else.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// The equations the fixtures carry. Chosen to be UNAMBIGUOUS on sight in a
// failure message and to evaluate to a round number, so a drag that clobbers one
// is reported as a string-vs-number difference rather than a near-miss.
const Y_EQUATION = "= 100 + 50";   // evaluates to 150
const H_EQUATION = "= 40 + 40";    // evaluates to 80

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // A cold private cache re-optimizes the whole dep graph on first load, which
  // outruns puppeteer's 30 s default — scene3d_probe's 180 s protocolTimeout has
  // the same origin.
  await page.goto(url, { waitUntil: "networkidle0", timeout: 180000 });
  await new Promise((r) => setTimeout(r, 600));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /** Creates a rect at a known pose with `equations` merged into its stored
   *  state, selects it, and returns its id plus its world transform. Uses
   *  app.addItem — the same primitive the crosshair placement calls on release —
   *  because "add-rect" ARMS placement rather than spawning (rotated_resize_probe's
   *  fix, mirrored). */
  const setupRect = (equations) => page.evaluate((equations) => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("rect").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 400], [["items", id, "y"], 150],
      [["items", id, "w"], 200], [["items", id, "h"], 80],
      ...Object.entries(equations).map(([key, value]) => [["items", id, key], value]),
    ]);
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    return { id, world: node.world, w: node.state.w, h: node.state.h };
  }, equations);

  /** Query. The RAW stored value of one leaf — where an equation is still an
   *  equation. app.storedItemValue is the app's own reader, so the probe cannot
   *  disagree with the app about which slide's delta to fold. */
  const stored = (id, key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), id, key);

  /** Command. Sets the lock to `on` through the REAL registry command, not by
   *  poking the field — so a broken command entry fails here rather than being
   *  bypassed. Returns the resulting app state. */
  const setLock = (on) => page.evaluate((on) => {
    const app = window.__powerrp_app;
    if (app.equationLock !== on) app.runCommand("toggle-equation-lock");
    return app.equationLock;
  }, on);

  /** The world point of an item's LOCAL (lx, ly), through the app's own
   *  transform — never a hardcoded screen coordinate, so zoom and pan are
   *  whatever the live viewport says. */
  const localToPage = (id, lx, ly) => page.evaluate((id, lx, ly) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    const T = node.world;
    const cos = Math.cos(T.rotation), sin = Math.sin(T.rotation), k = T.scale;
    const wx = T.x + k * (cos * lx - sin * ly), wy = T.y + k * (sin * lx + cos * ly);
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, id, lx, ly);

  /** A real pointer drag from `from` to `to` — page.mouse, because CanvasView's
   *  handlers call setPointerCapture and a synthetic dispatchEvent never reaches
   *  them (editor_smoke's standing note). */
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));
  };

  // ── 1. THE TOGGLE ITSELF: a surfacing of one registry entry ────────────────
  {
    const entry = await page.evaluate(() => {
      const cmd = window.__powerrp_app.commands.get("toggle-equation-lock");
      return cmd ? { title: cmd.title, icon: cmd.icon, hasHelp: !!cmd.help } : null;
    });
    ok(entry !== null, "the command registry has a `toggle-equation-lock` entry");
    ok(entry?.icon === "mdi:link-variant", `the icon is the CHAIN LINK the user chose (got ${entry?.icon})`);
    ok(entry?.hasHelp, "the entry carries `help` — the palette's only explanation of what the lock does");
    ok((await setLock(false)) === false, "DEFAULT/OFF: the lock can be turned off and reports off");
    const button = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const el = [...document.querySelectorAll(".toolbar button")].find((b) => b.getAttribute("aria-label") === app.commands.get("toggle-equation-lock").title);
      if (!el) return null;
      return { pressed: el.getAttribute("aria-pressed"), active: el.classList.contains("active"), icon: el.querySelector("iconify-icon")?.getAttribute("icon") };
    });
    ok(button !== null, "a toolbar button surfaces it, labelled from the registry title");
    ok(button?.pressed === "false" && button?.active === false, `the button reads OFF while the lock is off (${JSON.stringify(button)})`);
    ok((await setLock(true)) === true, "the command turns it on");
    const armed = await page.evaluate(() => {
      const app = window.__powerrp_app;
      const el = [...document.querySelectorAll(".toolbar button")].find((b) => b.getAttribute("aria-label") === app.commands.get("toggle-equation-lock").title);
      return { pressed: el.getAttribute("aria-pressed"), active: el.classList.contains("active"), icon: el.querySelector("iconify-icon")?.getAttribute("icon") };
    });
    ok(armed.pressed === "true" && armed.active === true, `the button reads ON while the lock is on (${JSON.stringify(armed)})`);
    ok(armed.icon === "mdi:link-variant", "the glyph does NOT swap with state — the four sibling toggles all say `on` with `active` alone");
  }

  // ── 2. BODY DRAG with `y` equation-bound, LOCK ON ──────────────────────────
  {
    await setLock(true);
    const rect = await setupRect({ y: Y_EQUATION });
    ok((await stored(rect.id, "y")) === Y_EQUATION, "fixture: y really is stored as an equation string");
    const from = await localToPage(rect.id, rect.w / 2, rect.h / 2);
    await drag(from, { x: from.x + 90, y: from.y + 70 });
    const y = await stored(rect.id, "y");
    const x = await stored(rect.id, "x");
    ok(y === Y_EQUATION, `LOCKED: the y equation is UNTOUCHED after a diagonal body drag (got ${JSON.stringify(y)})`);
    ok(typeof x === "number" && x !== 400, `…and x still moved, so the drag lost ONE degree of freedom, not all of them (x = ${x})`);
  }

  // ── 3. THE SAME DRAG, LOCK OFF — the control that makes check 2 mean something
  {
    await setLock(false);
    const rect = await setupRect({ y: Y_EQUATION });
    const from = await localToPage(rect.id, rect.w / 2, rect.h / 2);
    await drag(from, { x: from.x + 90, y: from.y + 70 });
    const y = await stored(rect.id, "y");
    ok(typeof y === "number", `UNLOCKED: the same drag DOES replace the equation with a literal (got ${JSON.stringify(y)}) — this is today's shipped behaviour and the reason the lock exists`);
  }

  // ── 4. HANDLE RESIZE with `h` equation-bound, LOCK ON ──────────────────────
  {
    await setLock(true);
    const rect = await setupRect({ h: H_EQUATION });
    ok((await stored(rect.id, "h")) === H_EQUATION, "fixture: h really is stored as an equation string");
    // The bottom-right handle: the item's own local (w, h) corner. Dragging it
    // asks for BOTH a width and a height — the user's own example of a corner
    // that must not go dead just because one axis is bound.
    const from = await localToPage(rect.id, rect.w, rect.h);
    await drag(from, { x: from.x + 60, y: from.y + 50 });
    const h = await stored(rect.id, "h");
    const w = await stored(rect.id, "w");
    ok(h === H_EQUATION, `LOCKED: the h equation survives a CORNER resize (got ${JSON.stringify(h)})`);
    ok(typeof w === "number" && w > 200, `…and the corner still resized the WIDTH (w = ${w}) — a half-locked corner is not a dead corner`);
  }

  // ── 5. THE AFFORDANCE: per degree of freedom, derived from the real gesture ─
  {
    await setLock(true);
    const rect = await setupRect({ h: H_EQUATION });
    const handles = await page.evaluate(() => {
      const app = window.__powerrp_app;
      // The overlay's own <title> is the SVG-native hover hint; reading it back is
      // reading exactly what a user hovers. `handle` rects are in document order,
      // which is the order CanvasView builds them: tl tm tr mr br bm bl ml.
      //
      // "DEAD" IS READ AS THE RENDERED OPACITY, NOT AS A MARKER CLASS, and the
      // correction is the whole reason this line changed. This check used to read
      // `classList.contains("locked")` — and passed, on a build where that class
      // matched NO rule in web/app.css, so the greyed look the user asked for
      // rendered exactly like a live handle. A probe that asserts the marker
      // certifies the intent; only the computed style can certify the pixel.
      const dead = (el) => Number(getComputedStyle(el).opacity) < 1;
      return [...document.querySelectorAll("rect.handle")].map((el) => ({
        cursor: el.style.cursor,
        locked: dead(el),
        note: el.querySelector("title")?.textContent ?? null,
      }));
    });
    ok(handles.length === 8, `the selected rect shows its eight resize handles (got ${handles.length})`);
    const [tl, tm, tr, mr, br, bm, bl, ml] = handles;
    ok(br.cursor === "ew-resize", `BR corner with h locked degrades to the WIDTH cursor, not to disabled (got ${br?.cursor})`);
    ok(br.locked === false, "…and is not GREYED, because it can still do something");
    ok(bm.cursor === "not-allowed" && bm.locked === true, `the BOTTOM-EDGE handle, whose only axis is h, IS dead AND VISIBLY GREY (cursor ${bm?.cursor}, dimmed ${bm?.locked})`);
    ok(mr.cursor === "ew-resize" && mr.locked === false && mr.note === null, "the RIGHT-EDGE handle is untouched — it never wrote h");
    ok(typeof br.note === "string" && br.note.includes('"h"') && br.note.includes("Equation Lock is on"),
      `a locked affordance says WHICH property and WHY (got ${JSON.stringify(br?.note)})`);
    ok([tl, tm, tr, bl, ml].every((h) => h.cursor !== ""), "every handle still declares a cursor (sanity — no undefined leaked into the style)");

    await setLock(false);
    await new Promise((r) => setTimeout(r, 80));
    const unlocked = await page.evaluate(() => [...document.querySelectorAll("rect.handle")].map((el) => ({ cursor: el.style.cursor, note: el.querySelector("title")?.textContent ?? null })));
    ok(unlocked.every((h) => h.note === null), "with the lock OFF no handle claims a restriction — the indicator reports the LOCK and nothing else");
    ok(unlocked[4].cursor === "nwse-resize", `…and the BR corner is its ordinary diagonal again (got ${unlocked[4]?.cursor})`);
  }

  // ── 6. THE BODY DRAG SAYS WHY (todo #240) ──────────────────────────────────
  // "An equation-bound coordinate silently refuses a drag — no widget says why."
  // A resize handle explained itself from the first commit; the BODY did not,
  // because the one sentence had one caller. The selection outline is
  // pointer-events:none like all overlay decoration, so it cannot host a hover
  // <title> — the canvas says this one in place, as text, the way it already says
  // an anchor's name.
  {
    await setLock(true);
    const rect = await setupRect({ y: Y_EQUATION });
    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, rect.id);
    await new Promise((r) => setTimeout(r, 80));
    // WHITESPACE-NORMALISED, because the tip is two <tspan> lines and the template's
    // own indentation lands between them as text nodes. The user reads two lines; the
    // assertion reads the one sentence they spell.
    const tip = await page.evaluate(() =>
      [...document.querySelectorAll(".overlay text")]
        .map((el) => el.textContent.replace(/\s+/g, " ").trim())
        .find((t) => t.startsWith("Cannot move:")) ?? null);
    ok(typeof tip === "string", `the canvas states the body drag's refusal in place (got ${JSON.stringify(tip)})`);
    ok(tip.includes('"y"') && tip.includes("Equation Lock is on") && tip.includes("switch the lock off"),
      "…and it is the SAME sentence the resize handle uses — one condition, one voice");

    // AND IT IS NOT AMBIENT. The tip exists only because the lock is armed; with
    // the lock off the identical selection must say nothing, or a default-off
    // feature would be shouting at every user who never turned it on.
    await setLock(false);
    await new Promise((r) => setTimeout(r, 80));
    const quiet = await page.evaluate(() =>
      [...document.querySelectorAll(".overlay text")].some((el) => el.textContent.replace(/\s+/g, " ").trim().startsWith("Cannot ")));
    ok(quiet === false, "with the lock OFF the canvas says nothing about it");
  }

  // ── THE ARROW ENDPOINT HANDLE, the user's own case ────────────────────────
  // "When the equation lock toggle is on, why am I able to move the handles of an
  // arrow that has been bound to anchors?" — because `endpoint` was one of six
  // drag kinds and the only one that never asked dragConstraint. LOCK_SURFACE
  // carried it as a justified null ("writes outside geometryPairs"), which was
  // TRUE, so nothing was lying; the exemption simply outlived its premise.
  //
  // ASSERTED IN BOTH DIRECTIONS. A test that only checks the equation survives
  // would also pass against an endpoint handle that had stopped working entirely,
  // which is the more likely way to break this while "fixing" it.
  {
    const arrow = await page.evaluate(() => {
      const app = window.__powerrp_app;
      app.addItem(app.registry.get("arrow").defaults);
      const id = app.selection;
      app.setPreview([
        [["items", id, "from", "x"], 300], [["items", id, "from", "y"], 400],
        [["items", id, "to", "x"], 500], [["items", id, "to", "y"], 400],
      ]);
      app.commitPreview();
      // `from.x` becomes an EQUATION — the shape an anchor binding leaves behind.
      app.setPreview([[["items", id, "from", "x"], "= 300 + 0"]]);
      app.commitPreview();
      return { id };
    });
    const storedLeaf = (id, a, b) => page.evaluate((id, a, b) =>
      window.__powerrp_app.storedItemValue(id, [a, b]), id, a, b);
    ok((await storedLeaf(arrow.id, "from", "x")) === "= 300 + 0",
      "setup: the arrow's from.x really is stored as an equation");

    const handleAt = () => page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((x) => x.itemId === id);
      const s = app.canvasActions.worldToScreen(n.state.from.x, n.state.from.y);
      const r = document.querySelector(".overlay").getBoundingClientRect();
      return { x: r.left + s.x, y: r.top + s.y };
    }, arrow.id);

    await setLock(true);
    await new Promise((r) => setTimeout(r, 80));
    const from = await handleAt();
    await drag(from, { x: from.x + 90, y: from.y + 60 });
    ok((await storedLeaf(arrow.id, "from", "x")) === "= 300 + 0",
      "LOCK ON: dragging the endpoint handle does NOT overwrite the equation on from.x");

    // The handle must also SAY so, in the one shared sentence — a silent refusal
    // is the #240 defect, not a fix for it.
    const tip = await page.evaluate(() =>
      [...document.querySelectorAll(".overlay circle.endpoint title")]
        .map((t) => t.textContent).find((t) => t.startsWith("Cannot drag this point:")) ?? null);
    ok(typeof tip === "string" && tip.includes('"from.x"') && tip.includes("Equation Lock is on"),
      `…and the handle explains itself in the shared voice (got ${JSON.stringify(tip)})`);

    // THE OTHER DIRECTION: with the lock off the same drag must still work, or
    // this "fix" has merely broken the endpoint handle.
    await setLock(false);
    await new Promise((r) => setTimeout(r, 80));
    const free = await handleAt();
    await drag(free, { x: free.x + 90, y: free.y + 60 });
    const after = await storedLeaf(arrow.id, "from", "x");
    ok(after !== "= 300 + 0" && typeof after === "number",
      `LOCK OFF: the same drag still moves the endpoint and replaces the equation (got ${JSON.stringify(after)})`);
  }

  ok(liveErrors.length === 0, `zero console errors during all interactions (${JSON.stringify(liveErrors)})`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} equation-lock browser checks passed`);
} finally {
  await browser.close();
  await server.close();
}
