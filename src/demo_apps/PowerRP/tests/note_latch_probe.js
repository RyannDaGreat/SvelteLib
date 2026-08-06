/**
 * THE NOTE LATCH and THE PIANO ROLL in a real browser (R7-13, R7-14).
 *
 * ── WHAT ONLY THIS CAN PROVE ────────────────────────────────────────────────
 * tests/note_latch_test.js proves every PURE half in bare node: the chord folds,
 * the pattern reaches `readAudioScene`, the engine module sounds distinct pitches.
 * Three things live entirely outside that and are each the whole feature:
 *
 *   1. THE GESTURE. A click on a locked keyboard must WRITE THE DOCUMENT instead of
 *      firing a live press, and a click on the piano roll must place a note. That
 *      branch is in web/CanvasView.svelte `startLivePlay`, reached only by a real
 *      pointer through a real hit test at a real world transform.
 *   2. THE CHORD SURVIVING A SLIDE CHANGE. web/CanvasView.svelte releases every
 *      held note on every slide change — `engine.allNotesOff`, wholesale, because it
 *      cannot tell a finger's note from the document's. The user asked for a lock
 *      precisely so a chord survives one, so the mirror RE-ASSERTS what it just
 *      silenced. Nothing in bare node can see that: it is two Svelte effects, an
 *      engine and an ordering.
 *   3. THE NOTES ACTUALLY REACHING THE ENGINE. The scene says what should be sent;
 *      only the running mirror says what was.
 *
 * ── HOW IT MEASURES ─────────────────────────────────────────────────────────
 * NOT by ear — headless has no output device, and an audio-buffer assertion would
 * measure the harness. It WRAPS `engine.noteOn`/`noteOff`/`setParam`, which is the
 * last hop before the voice pool and the AudioParam, exactly as
 * tests/audio_frame_seam_probe.js does and for the same reason. The engine is
 * reached by importing the app's OWN module through the dev server, so this observes
 * the singleton the app is driving rather than a second one it built.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/note_latch_probe.js
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

/** Which piano keys this probe latches — the low C and the G a fifth above it, so
 *  "two DISTINCT notes reached the engine" cannot be confused with one note twice.
 *  As FRACTIONS of the keyboard's white-key span, resolved against the real layout
 *  in the page rather than hardcoded as pixels. */
const CHORD_WHITE_KEYS = [0, 4];
/** The steps the piano-roll half clicks, and the pitch ROW (from the top) each one
 *  is clicked on. Three different rows, so three different pitches. */
const ROLL_CELLS = [{ step: 0, row: 11 }, { step: 4, row: 7 }, { step: 8, row: 4 }];

// HMR IS OFF, for the reason cli/render_job.js turns it off and
// tests/audio_frame_seam_probe.js records: in a worktree with other agents editing,
// a source save mid-run reloads the page and destroys the session being measured.
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // THE SPLASH MUST LIFT BEFORE ANY SYNTHETIC CLICK: it is fixed, inset 0,
  // z-index 9999 until the first painted frame, so a tap before then lands on the
  // splash. 120 s for the reason tests/present_reachable_probe.js records — with
  // several agents' Vite servers on one host the dep optimizer keeps the network
  // busy well past the app being interactive.
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });

  const settle = (ms = 220) => sleep(ms);
  /** Query. A LOCAL point on an item, in page coordinates. */
  const pointOn = (id, lx, ly) => page.evaluate((id, lx, ly) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const s = app.canvasActions.worldToScreen(n.state.x + lx, n.state.y + ly);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, id, lx, ly);
  /**
   * Query. One leaf of one item, ROUND-TRIPPED THROUGH JSON INSIDE THE PAGE.
   *
   * The round trip is load-bearing and cost half an hour to find. The evaluated
   * state is built from Svelte 5 `$state`, which is a deep PROXY, and CDP's
   * return-by-value serializer does not see a Proxy over an Array as an array — a
   * `[[48], [55]]` chord arrives here as `{"0": {"0": 48}, "1": {"0": 55}}`. Every
   * `.length` and `.map` on it then fails, which reads exactly like the feature
   * being broken and is not. Stringifying on the page's side settles the shape
   * where the real objects are.
   */
  const itemState = (id, key) => page.evaluate(
    (id, key) => JSON.parse(JSON.stringify(window.__powerrp_app.state().items[id]?.[key] ?? null)), id, key);

  // ── THE DECK: a keyboard and a piano roll, each into its own poly pad ──────
  const ids = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const add = (type, x, y) => { app.addItem({ ...app.registry.get(type).defaults, x, y }); return app.selection; };
    const wire = (src, sp, dst, dp) => {
      app.setPreview([[["items", dst, "inputs", dp], { item: src, port: sp }]]);
      app.commitPreview();
    };
    const keyboard = add("node_keyboard", 80, 80);
    const pad = add("audio_poly_pad", 500, 80);
    const out = add("audio_output", 800, 80);
    wire(keyboard, "gate", pad, "gate");
    wire(keyboard, "pitch", pad, "pitch");
    wire(pad, "out", out, "in");
    const roll = add("node_piano_roll", 80, 420);
    const rollPad = add("audio_poly_pad", 500, 420);
    wire(roll, "gate", rollPad, "gate");
    wire(roll, "pitch", rollPad, "pitch");
    wire(rollPad, "out", out, "in");
    app.selection = null;
    return { keyboard, pad, out, roll, rollPad };
  });
  await settle(500);

  // ── AUDIO ON, FROM ONE ORDINARY CLICK ─────────────────────────────────────
  const empty = await page.evaluate(() => {
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + r.width - 30, y: r.top + r.height - 30 };
  });
  await page.mouse.click(empty.x, empty.y);
  await page.waitForFunction(() => window.__powerrp_audioState().status !== "blocked", { timeout: 15000 }).catch(() => {});
  const status = await page.evaluate(() => window.__powerrp_audioState());
  ok(status.status === "running", `audio is running (${status.status}: ${status.reason})`);

  // ── INSTRUMENT THE LAST HOP ───────────────────────────────────────────────
  const shared = await page.evaluate(async () => {
    const mirror = await import("/audioMirror.svelte.js");
    const engine = mirror.audioEngine();
    if (!engine) return `audioEngine() is null while the app reports ${window.__powerrp_audioState().status}`;
    window.__noteLog = [];
    window.__stepLog = [];
    const on = engine.noteOn.bind(engine), off = engine.noteOff.bind(engine);
    const all = engine.allNotesOff.bind(engine), setP = engine.setParam.bind(engine);
    engine.noteOn = (id, note, f, t) => { window.__noteLog.push({ op: "on", id, note }); return on(id, note, f, t); };
    engine.noteOff = (id, note, t) => { window.__noteLog.push({ op: "off", id, note }); return off(id, note, t); };
    engine.allNotesOff = (id) => { window.__noteLog.push({ op: "all", id }); return all(id); };
    engine.setParam = (id, key, value, o) => {
      if (key === "steps") window.__stepLog.push({ id, on: value.filter((x) => x.on).map((x) => x.note) });
      return setP(id, key, value, o);
    };
    return null;
  });
  ok(shared === null, `the probe reached the APP's audio module and wrapped its engine (${shared ?? "ok"})`);
  const noteLog = () => page.evaluate(() => window.__noteLog.slice());
  const clearLogs = () => page.evaluate(() => { window.__noteLog = []; window.__stepLog = []; });

  // ── WHERE THE KEYS ARE ────────────────────────────────────────────────────
  const keyPoints = await page.evaluate((id, which) => {
    const app = window.__powerrp_app;
    const plugin = app.registry.get("node_keyboard");
    const n = app.nodes().find((x) => x.itemId === id);
    const whites = plugin.keyboardKeys(n.state).filter((k) => !k.black);
    return which.map((i) => {
      const k = whites[i];
      // 90% down the key: unambiguously white, clear of any black key's overhang.
      return { lx: k.x + k.w / 2, ly: k.y + k.h * 0.9, note: k.note };
    });
  }, ids.keyboard, CHORD_WHITE_KEYS);
  ok(keyPoints.length === 2 && keyPoints[0].note !== keyPoints[1].note,
    `two DISTINCT white keys located (${keyPoints.map((k) => k.note).join(", ")})`);

  // ── 1. LOCK OFF: A PRESS IS LIVE AND WRITES NOTHING ───────────────────────
  await clearLogs();
  {
    const p = await pointOn(ids.keyboard, keyPoints[0].lx, keyPoints[0].ly);
    await page.mouse.click(p.x, p.y);
  }
  await settle();
  ok((await itemState(ids.keyboard, "heldNotes")).length === 0,
    "with the lock OFF a press writes NOTHING to the document — a moment, not a value");
  const livePress = await noteLog();
  ok(livePress.some((e) => e.op === "on" && e.note === keyPoints[0].note) && livePress.some((e) => e.op === "off"),
    `…and it sounded and released as a live note (${JSON.stringify(livePress)})`);

  // ── 2. LOCK ON: A PRESS LATCHES ───────────────────────────────────────────
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "keyLock"], true]]);
    app.commitPreview();
  }, ids.keyboard);
  await settle();
  await clearLogs();
  for (const k of keyPoints) {
    const p = await pointOn(ids.keyboard, k.lx, k.ly);
    await page.mouse.click(p.x, p.y);
    await settle();
  }
  const held = await itemState(ids.keyboard, "heldNotes");
  ok(held.length === 2 && held.flat().sort((a, b) => a - b).join() === keyPoints.map((k) => k.note).sort((a, b) => a - b).join(),
    `two clicks LATCHED two notes into the document (${JSON.stringify(held)})`);
  const latchedOn = (await noteLog()).filter((e) => e.op === "on");
  ok(latchedOn.length === 2 && new Set(latchedOn.map((e) => e.note)).size === 2,
    `…and the engine was told to sound BOTH, as distinct notes (${JSON.stringify(latchedOn)})`);
  ok((await noteLog()).filter((e) => e.op === "off").length === 0,
    "…and NOTHING released them — that is what 'stay turned on at all times' means");

  // THE PICTURE AGREES WITH THE DOCUMENT: the latched keys are in the DISPLAY LIST,
  // not in a screen-space overlay, because a latch is document state and must
  // therefore survive into an export.
  const painted = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const ops = app.registry.get("node_keyboard").emit(n.state, null, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const rest = app.registry.get("node_keyboard").emit({ ...n.state, heldNotes: [] }, null, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const fills = (list) => list.filter((o) => o.op === "rect").map((o) => JSON.stringify(o.fill));
    const a = fills(ops), b = fills(rest);
    return a.filter((f, i) => f !== b[i]).length;
  }, ids.keyboard);
  ok(painted === 2, `the two latched keys are painted DOWN in the display list (${painted} rects differ from the resting card)`);

  // ── 3. THE CHORD SURVIVES A SLIDE CHANGE ──────────────────────────────────
  // A second slide with a DIFFERENT chord, which is the user's own requirement:
  // "to let me play different chords and different slides."
  await page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.addSlide();
    app.setPreview([[["items", id, "heldNotes"], [[72]]]]);
    app.commitPreview();
  }, ids.keyboard);
  await settle(500);
  await clearLogs();
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; });
  await settle(700);
  const backOnOne = await noteLog();
  const soundingAfter = new Set();
  for (const e of backOnOne) {
    if (e.op === "on") soundingAfter.add(e.note);
    if (e.op === "off") soundingAfter.delete(e.note);
    if (e.op === "all") soundingAfter.clear();
  }
  ok(backOnOne.some((e) => e.op === "all"),
    "the slide change DID release every note wholesale (the behaviour the latch has to survive)");
  ok([...soundingAfter].sort((a, b) => a - b).join() === keyPoints.map((k) => k.note).sort((a, b) => a - b).join(),
    `…and slide 1's chord was RE-ASSERTED after it (sounding: ${JSON.stringify([...soundingAfter])})`);
  ok((await itemState(ids.keyboard, "heldNotes")).length === 2, "…and the document still says so on slide 1");
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 1; });
  await settle(700);
  const onTwo = await itemState(ids.keyboard, "heldNotes");
  ok(onTwo.length === 1 && onTwo[0][0] === 72, `slide 2 holds its OWN, different chord (${JSON.stringify(onTwo)})`);
  await page.evaluate(() => { window.__powerrp_app.slideIndex = 0; });
  await settle(500);

  // ── 4. THE PIANO ROLL: CLICKING CELLS AUTHORS A PATTERN ───────────────────
  const cellPoints = await page.evaluate((id, cells) => {
    const app = window.__powerrp_app;
    const plugin = app.registry.get("node_piano_roll");
    const n = app.nodes().find((x) => x.itemId === id);
    const face = plugin.controlFace(n.state);
    const steps = Number(n.state.audioStepCount);
    const rowCount = Math.max(1, Math.round(Number(n.state.octaves))) * 12;
    return cells.map((c) => ({
      lx: face.x + (c.step + 0.5) * (face.w / steps),
      ly: face.y + (c.row + 0.5) * (face.h / rowCount),
    }));
  }, ids.roll, ROLL_CELLS);
  await clearLogs();
  for (const c of cellPoints) {
    const p = await pointOn(ids.roll, c.lx, c.ly);
    await page.mouse.click(p.x, p.y);
    await settle();
  }
  const notes = await itemState(ids.roll, "notes");
  ok(Array.isArray(notes) && notes.length === 3, `three clicks placed three notes (${JSON.stringify(notes)})`);
  const pairs = Array.isArray(notes) ? notes : [];
  ok(new Set(pairs.map((n) => n[0])).size === 3 && new Set(pairs.map((n) => n[1])).size === 3,
    "…on three distinct steps, at three DISTINCT pitches");

  // AND THEY REACH THE ENGINE. The scene is what the mirror computed; `__stepLog` is
  // what the engine was actually told, which is the claim that matters.
  const sceneSteps = await page.evaluate((id) => {
    const m = window.__powerrp_audioScene()?.modules?.[id];
    return (m?.knobs?.steps ?? []).filter((x) => x.on).map((x) => x.note);
  }, ids.roll);
  ok(sceneSteps.length === 3 && new Set(sceneSteps).size === 3,
    `the mirrored scene carries THREE DISTINCT PITCHES (${JSON.stringify(sceneSteps)}) — the Sequencer's bar of rests is what this replaces`);
  const sent = await page.evaluate(() => window.__stepLog.slice());
  const lastSent = sent.filter((s) => s.on.length === 3).pop();
  ok(lastSent && new Set(lastSent.on).size === 3,
    `…and engine.setParam("steps") was called with them (${JSON.stringify(lastSent)})`);
  ok(pairs.map((n) => n[1]).sort((a, b) => a - b).join() === sceneSteps.slice().sort((a, b) => a - b).join(),
    "…and the pitches the engine got are exactly the ones the grid shows");

  // ── 5. CLICKING A PLACED NOTE CLEARS IT ───────────────────────────────────
  {
    const p = await pointOn(ids.roll, cellPoints[0].lx, cellPoints[0].ly);
    await page.mouse.click(p.x, p.y);
  }
  await settle();
  ok((await itemState(ids.roll, "notes")).length === 2, "clicking a placed note clears its step");

  // AN UNCHANGED PATTERN MUST NOT KEEP TALKING TO THE ENGINE. Two folds build two
  // equal arrays, so without a structural compare every idle frame would push one.
  await clearLogs();
  await page.evaluate(() => { const a = window.__powerrp_app; a.setPreview([[["items", a.doc.slides[0].id, "name"], "1"]]); a.cancelPreview(); });
  await settle(900);
  ok((await page.evaluate(() => window.__stepLog.length)) === 0,
    `an idle second sends the pattern ZERO times (${await page.evaluate(() => window.__stepLog.length)})`);

  ok(liveErrors.length === 0, `no page errors: ${liveErrors.slice(0, 3).join(" | ")}`);
} catch (e) {
  // A THROW MUST NOT SWALLOW THE CHECKS ALREADY MADE. A probe that dies at check 14
  // and prints nothing reports "everything is broken" when thirteen things worked.
  errors.push(`THREW: ${e.stack ?? e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\nnote_latch_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (errors.length) { console.error(`\n${errors.join("\n")}`); process.exit(1); }
