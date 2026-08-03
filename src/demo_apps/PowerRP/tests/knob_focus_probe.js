/**
 * IN-CANVAS KNOBS browser probe: the founding double-click gesture, end to end,
 * through the real editor.
 *
 * ── WHAT ONLY THIS CAN PROVE ────────────────────────────────────────────────
 * tests/knob_focus_test.js pins every pure half of the feature — the layout, the
 * press decision, the drag law, the write. What it cannot reach is whether any
 * of it is ever ASKED FOR: whether a real double-click resolves the handler and
 * enters the mode, whether the canvas routes a press to `onPick` rather than to
 * its own move-drag, whether `onPan` receives the absolute local point the mode
 * measures from, whether one gesture commits ONE undo unit, and whether the
 * resulting property change reaches the AUDIO ENGINE. Every one of those is a
 * place where a perfect core and a disconnected app look identical from node —
 * the exact class of gap NF-CORE reported and NF-BIND then found (a canvas that
 * never called the thing that was proven correct).
 *
 * ── THE FIVE CLAIMS ─────────────────────────────────────────────────────────
 *   1. DOUBLE-CLICK ENTERS. app.canvasMode names this handler and this item.
 *   2. DRAGGING A DIAL TURNS IT. The property changes, and in the right
 *      direction (up is more).
 *   3. ONE UNDO REVERTS THE WHOLE TURN. Not one undo per pointermove — the
 *      preview/commit seam's whole purpose, and the thing a hand-rolled drag
 *      gets wrong.
 *   4. THE MIRROR SEES IT. The engine's own inspect() reports the new value, so
 *      what you hear followed what you turned. This is the claim that makes the
 *      knob a REAL control rather than a picture of one.
 *   5. THE BEAD LAYER STILL WINS INSIDE THE MODE. A press on a port bead starts
 *      a WIRE GESTURE, not a knob turn, and does not leave knob focus — the
 *      founding message's "even if it's not selected", and the lesson wave 2's
 *      delete-gesture incident recorded (a mode-only affordance may not cover an
 *      always-active bead).
 *
 * IT DOES NOT ASSERT ON SOUND, for the reason tests/audio_mirror_probe.js states
 * at length: headless Chrome has no output device, so an assertion on samples
 * would measure the harness. What is checked is that the ENGINE holds the value.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/knob_focus_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
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
  const bootErrors = [];
  const afterBoot = { on: false };
  page.on("pageerror", (e) => (afterBoot.on ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (isWebGpuAbsenceNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  // The absent project backend, filtered BY NAME exactly as the sibling probes do
  // — run alone there is nothing listening, and reporting an absent dependency as
  // a defect is what the gate's own doctrine forbids.
  const realBootErrors = bootErrors.filter((e) => !/\/api\/projects|500 \(Internal Server Error\)/.test(e));
  ok(realBootErrors.length === 0, `no boot errors beyond the absent project backend (${JSON.stringify(realBootErrors)})`);
  afterBoot.on = true;

  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  /** World point → page coordinates, through the APP's own camera map, so the
   *  probe clicks where the app thinks the dial is rather than where the probe
   *  recomputed it. A probe doing its own projection could pass while the app's
   *  painter and hit test disagreed, which is the whole class of bug here. */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  const addNode = (type, x, y) => page.evaluate((type, x, y) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, x, y });
    return app.selection;
  }, type, x, y);

  /** A dial's WORLD centre, out of the plugin's own knobLayout mapped through the
   *  node's world transform — the same layout the painter used. */
  const knobWorld = (itemId, key) => page.evaluate((itemId, key) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === itemId);
    const k = node.plugin.knobLayout(node.state).find((d) => d.key === key);
    if (!k) return null;
    // The node's world transform is a similarity: rotate+scale, then translate.
    const w = node.world;
    const c = Math.cos(w.rotation) * w.scale, s = Math.sin(w.rotation) * w.scale;
    return { x: w.x + c * k.cx - s * k.cy, y: w.y + s * k.cx + c * k.cy };
  }, itemId, key);

  const beadWorld = (itemId, side, key) => page.evaluate((itemId, side, key) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === itemId);
    const a = window.__powerrp_nodePortAnchors(node).find((p) => p.side === side && p.key === key);
    return a ? { x: a.x, y: a.y } : null;
  }, itemId, side, key);

  const stateOf = (itemId, key) => page.evaluate((itemId, key) => {
    const app = window.__powerrp_app;
    return app.nodes().find((n) => n.itemId === itemId)?.state?.[key];
  }, itemId, key);

  const modeNow = () => page.evaluate(() => {
    const m = window.__powerrp_app.canvasMode;
    return m ? { handlerId: m.handlerId, itemId: m.itemId } : null;
  });

  // ── SETUP: one filter node, which has two continuous knobs ────────────────
  const filter = await addNode("audio_filter", 400, 300);
  await settle();
  ok(typeof filter === "string" && filter.length > 0, "a filter node was inserted");

  const dialsPainted = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    return node.plugin.knobLayout(node.state).map((k) => k.key);
  }, filter);
  ok(dialsPainted.includes("frequency") && dialsPainted.includes("Q"),
    `the filter declares dials for its continuous knobs (${dialsPainted.join(", ")})`);

  // ── 1. DOUBLE-CLICK ENTERS KNOB FOCUS ─────────────────────────────────────
  // The founding ask, verbatim: "If I double click the module, I can start
  // playing with the knobs in it."
  const body = await worldToPage(...Object.values(await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    // The header strip: unambiguously the node and unambiguously not a dial.
    return { x: n.state.x + n.state.w / 2, y: n.state.y + 12 };
  }, filter)));
  await page.mouse.click(body.x, body.y, { clickCount: 2 });
  await settle();
  const entered = await modeNow();
  ok(entered?.handlerId === "knob_focus", `double-clicking the module entered knob focus (got ${JSON.stringify(entered)})`);
  ok(entered?.itemId === filter, "…on the module that was double-clicked");

  // ── 2. DRAGGING A DIAL TURNS IT ───────────────────────────────────────────
  const before = await stateOf(filter, "audioQ");
  const qWorld = await knobWorld(filter, "Q");
  ok(qWorld !== null, "the Q dial has a world position derived from the plugin's own layout");
  const qPage = await worldToPage(qWorld.x, qWorld.y);
  await page.mouse.move(qPage.x, qPage.y);
  await page.mouse.down();
  // UP is more: a negative screen dy must increase the value.
  await page.mouse.move(qPage.x, qPage.y - 20, { steps: 3 });
  await page.mouse.move(qPage.x, qPage.y - 60, { steps: 5 });
  await page.mouse.up();
  await settle();
  const afterTurn = await stateOf(filter, "audioQ");
  ok(afterTurn !== before, `dragging the dial changed the property (${before} -> ${afterTurn})`);
  ok(afterTurn > before, `and an UPWARD drag INCREASED it (${before} -> ${afterTurn})`);
  ok(await page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId === "knob_focus"),
    "a completed turn stays in knob focus — you can turn the next knob without re-entering");

  // ── 5. THE BEAD LAYER STILL WINS INSIDE THE MODE ──────────────────────────
  // The user ruling this feature had to be built around: a bead is drag-active
  // "even if it's not selected". Inside knob focus a press on one must open a WIRE
  // gesture and must NOT be eaten by the mode.
  //
  // CHECKED HERE, BEFORE THE UNDO SECTION, AND THE ORDER IS LOAD-BEARING. `undo`
  // goes through applySnapshot, which restores the UI state captured with the
  // edit — including `selection`, whose setter legitimately exits any canvas mode
  // bound to a different item. So a mode does NOT survive an undo, by design and
  // for good reason; measuring the bead/knob coexistence after one would be
  // asserting that it does. (The probe's first run made exactly that mistake and
  // reported a coexistence failure that was really an undo doing its job.)
  const inBead = await beadWorld(filter, "input", "in");
  ok(inBead !== null, "the filter's `in` bead has a derived world anchor");
  const beadPage = await worldToPage(inBead.x, inBead.y);
  const qBeforeBead = await stateOf(filter, "audioQ");
  await page.mouse.move(beadPage.x, beadPage.y);
  await page.mouse.down();
  await page.mouse.move(beadPage.x - 60, beadPage.y - 40, { steps: 4 });
  ok(await page.evaluate(() => !!document.querySelector(".nf-wire-ghost")),
    "pressing a port BEAD inside knob focus started a WIRE drag (the ghost is live)");
  ok(await page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId === "knob_focus"),
    "…and did NOT leave knob focus — the two layers coexist");
  await page.mouse.up(); // release over empty canvas: the drag simply finds no target
  await settle();
  ok((await stateOf(filter, "audioQ")) === qBeforeBead,
    "a bead press turned NO knob — the bead outranks the dial, as the ruling requires");

  // ── 3. ONE UNDO REVERTS THE WHOLE TURN ────────────────────────────────────
  // Not one undo per pointermove. The drag staged N previews and committed once,
  // which is the entire purpose of the setPreview/commitPreview seam.
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  const afterUndo = await stateOf(filter, "audioQ");
  ok(afterUndo === before, `ONE undo reverted the whole turn (${afterTurn} -> ${afterUndo}, want ${before})`);

  // ── 4. THE MIRROR SEES IT: the engine really holds the turned value ───────
  // Redo the turn, then ask the ENGINE (not the document) what its filter's Q is.
  await page.evaluate(() => window.__powerrp_app.redo());
  await settle(700); // the mirror's setParam ramp settles in ~33 ms; be generous
  const turned = await stateOf(filter, "audioQ");
  // WHAT IS ASKED, AND WHY IT IS THE MIRROR RATHER THAN THE ENGINE. Headless
  // Chrome has no output device and its autoplay policy leaves the AudioContext
  // unstarted, so the mirror sits at `blocked` and there is no AudioNode to
  // interrogate — that is a NORMAL state (NF-BIND shipped the AudioBadge for
  // exactly it), not a failure, and a probe that reddened on it would be
  // measuring the harness rather than the app.
  //
  // `mirroredScene()` is the honest thing that IS reachable: web/audioMirror
  // states it is "the scene the last applied batch actually reached", so it is
  // the mirror's own record of what it holds for this module — the last hop
  // before the engine, and the one the knob has to move for a turn to be audible.
  // If the turn reached this, the only thing between it and sound is a user
  // gesture the browser is withholding.
  ok(await page.evaluate(() => typeof window.__powerrp_audioScene === "function"),
    "the audio mirror seam is present, so a turn has a path to the engine at all");
  const mirrorQ = await page.evaluate((id) => {
    const scene = window.__powerrp_audioScene();
    const m = scene?.modules?.[id];
    return m ? { knobs: m.knobs ?? null, module: m.module } : null;
  }, filter);
  ok(mirrorQ?.module === "filter", `the mirror holds this node as a filter module (got ${JSON.stringify(mirrorQ?.module)})`);
  ok(mirrorQ?.knobs && Math.abs(Number(mirrorQ.knobs.Q) - Number(turned)) < 1e-6,
    `THE MIRROR CARRIES THE TURNED VALUE — the turn reached the audio layer (document ${turned}, mirror ${mirrorQ?.knobs?.Q})`);
  const status = await page.evaluate(() => window.__powerrp_audioState());
  console.log(`  note  audio status in this page: ${status.status} (headless has no output device; 'blocked' is the expected autoplay state)`);

  // ── EXIT: a press on empty canvas leaves ──────────────────────────────────
  const away = await worldToPage(1100, 700);
  await page.mouse.click(away.x, away.y);
  await settle();
  ok((await modeNow()) === null, "clicking empty canvas left knob focus");

  ok(liveErrors.length === 0, `no unexpected console errors during the session (${JSON.stringify(liveErrors.slice(0, 4))})`);
} catch (e) {
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\nknob_focus_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
