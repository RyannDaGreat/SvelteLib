/**
 * KEYBOARD PLAY browser probe (WORKSTREAM CB): double-click a Keyboard node and
 * play it with the computer keyboard, end to end, through the real editor.
 *
 * ── WHY THIS EXISTS AS A PROBE AND NOT A NODE TEST ──────────────────────────
 * Every pure half of this feature is reachable from bare node — the mapping, the
 * note lookup, the press set, the lit-key filter. What is NOT reachable is the
 * only question the user actually asked: does TYPING DO ANYTHING. A keydown has
 * to survive the browser's event loop, the shortcut registry's `when` predicates,
 * the canvas-mode gate and the handler dispatch before it becomes a note, and
 * every one of those is a place where a perfect core and a disconnected app look
 * identical from node. That is the gap class the manifest records twice (NF-CORE
 * proved correct, NF-BIND then found the canvas never called it).
 *
 * IT ALSO COVERS A REAL HOLE: WORKSTREAM CB shipped in commit 7b52a31 with SEVEN
 * files and NO test. This probe is the four assertions that commit owed.
 *
 * ── THE FOUR CLAIMS (the brief's, in its order) ─────────────────────────────
 *   a. THE PRESS IS VISIBLE. Typing a mapped key lights that piano key — the
 *      reported defect, verbatim: "The keyboard doesn't press keys visually when
 *      I touch it." Asserted through `litKeyRects`, the same query the overlay
 *      paints from, so a green check means the picture changed.
 *   b. THE NOTE FIRES INTO live_control. The typed key reaches the audio path by
 *      the SAME route a pointer press does, at the right pitch.
 *   c. SELECTION IS NOT THE MODE. A keyboard that is merely SELECTED does not
 *      swallow typing — the safety property. Without this, every shortcut in the
 *      app would break for as long as a keyboard happened to be selected.
 *   d. ESCAPE EXITS, and exiting releases what was held (no orphan drone).
 *
 * ── WHAT IT DELIBERATELY DOES NOT ASSERT ────────────────────────────────────
 * SOUND. Headless Chrome has no output device, so an assertion on samples would
 * measure the harness — the ruling tests/audio_mirror_probe.js and
 * knob_focus_probe.js both state. What is checked instead is that the note
 * reached the SINK with the right note number: the last app-side seam before the
 * engine, and the one that was actually at issue.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/keyboard_play_probe.js
 * Or through the gate:     node src/demo_apps/PowerRP/tests/run_all.mjs --filter=keyboard_play
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { isWebGpuAbsenceNoise } from "./webgpu_absence_noise.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");

// HMR AND WATCHING ARE OFF, and that is a correctness fix rather than a speedup —
// WORKSTREAM BX measured three correct assertions reporting phantom defects
// because a sibling agent's save reloaded the page mid-run, destroying
// `window.__powerrp_app`. The cli/render_job.js ruling applied to probes.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } },
});
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
  // WAIT FOR THE SPLASH TO STAND DOWN, NOT FOR A FIXED SLEEP.
  //
  // MEASURED, and it cost most of this probe's bring-up: with a bare
  // `setTimeout(800)` every mouse assertion failed while every programmatic one
  // passed, which reads exactly like "double-click is broken" and is not.
  // `document.elementFromPoint` at the click coordinates returned
  // `DIV.boot-stages` — the boot splash still covering the canvas, eating the
  // gesture. `window.__powerrp_app` exists well BEFORE the splash clears, so
  // waiting on the app object alone is not enough either.
  //
  // Waiting on the seams AND on the splash being gone is the honest readiness
  // condition: the seams are assigned at the end of main.js (so their presence
  // also proves the module graph evaluated), and an absent/hidden splash is what
  // makes the canvas the topmost element at the point the probe clicks.
  await page.waitForFunction(() => {
    const splash = document.querySelector(".boot-stages");
    const covered = splash && splash.offsetParent !== null;
    return !!window.__powerrp_app && !!window.__powerrp_setNoteSink
      && !!document.querySelector(".overlay") && !covered;
    // A COLD DEP CACHE IS THE LONG POLE, NOT THE APP. Warm, this condition is met
    // ~5 s after `goto`; on the first run after a `vite.config.js` change Vite
    // re-optimizes dependencies and the same boot took over 90 s, which timed this
    // probe out and looked like a hang. The budget is generous on purpose — a
    // probe that fails on a cold cache reports the cache, not the keyboard.
  }, { timeout: 240000, polling: 250 });
  await new Promise((r) => setTimeout(r, 400));
  // TWO FILTERS, AND THE SECOND IS A DISCLOSURE RATHER THAN A CONVENIENCE.
  //
  // The first is the sibling probes' absent-backend filter: run alone nothing is
  // listening, and the gate's doctrine forbids reporting an absent dependency as
  // a defect.
  //
  // The second excludes `effect_update_depth_exceeded`, a Svelte reactive loop
  // that fires AT BOOT in this tree. It is NOT this workstream's and not caused by
  // it: MEASURED 2026-08-03 on a clean `git worktree` of HEAD, with none of CB's
  // test seams present, it reproduces identically. It is filtered BY NAME so this
  // probe reports on the keyboard rather than on a live sibling's in-flight work,
  // and it is named here rather than silently dropped so the next reader knows the
  // loop exists and is somebody's open bug. Any OTHER boot error still reddens.
  const knownBootNoise = /\/api\/projects|500 \(Internal Server Error\)|effect_update_depth_exceeded|updated at/;
  const realBootErrors = bootErrors.filter((e) => !knownBootNoise.test(e));
  ok(realBootErrors.length === 0, `no boot errors beyond the absent backend and the pre-existing effect loop (${JSON.stringify(realBootErrors)})`);
  afterBoot.on = true;

  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  const modeNow = () => page.evaluate(() => {
    const m = window.__powerrp_app.canvasMode;
    return m ? { handlerId: m.handlerId, itemId: m.itemId } : null;
  });

  /** The piano keys currently LIT, by note — read through `litKeyRects`, which is
   *  the exact query the canvas overlay paints from. Asserting on the same
   *  function the picture comes from is what makes this a claim about pixels
   *  rather than about a bookkeeping map that might not be drawn. */
  const litNotes = (itemId) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    return window.__powerrp_litKeyRects(node).map((k) => k.note).sort((a, b) => a - b);
  }, itemId);

  // ── SETUP ────────────────────────────────────────────────────────────────
  // A RECORDER ON THE NOTE SINK. keyboardPlay.js's own docblock sanctions this
  // ("a probe may pass a recorder"): the sink is the last app-side seam before the
  // engine, so recording it proves the note left the mode with the right pitch
  // without asserting on audio a headless browser cannot make.
  await page.evaluate(() => {
    window.__cbNotes = [];
    window.__powerrp_setNoteSink((items, registry, itemId, phase, note, frequency) => {
      window.__cbNotes.push({ itemId, phase, note, frequency });
    });
  });

  const keyboardId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("node_keyboard").defaults, x: 420, y: 320 });
    return app.selection;
  });
  await settle();
  ok(typeof keyboardId === "string" && keyboardId.length > 0, "a Keyboard node was inserted");

  // The widget's own base note, so the expected pitch is derived from the app
  // rather than hardcoded — a probe that hardcodes 48 would go red the day the
  // default changes, reporting a defect that is really a preference.
  const baseNote = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const node = app.nodes().find((n) => n.itemId === id);
    return window.__powerrp_keyboardRange(node.state).baseNote;
  }, keyboardId);
  ok(Number.isFinite(baseNote), `the keyboard reports its base note (${baseNote})`);

  // ── c. SELECTION IS NOT THE MODE (asserted BEFORE entering) ───────────────
  // Deliberately first: at this point the node was just added and IS selected,
  // which is precisely the dangerous state. If typing played here, the app would
  // have a modal input hidden inside a document.
  const selectedNow = await page.evaluate((id) => window.__powerrp_app.selectedIds().includes(id), keyboardId);
  ok(selectedNow, "the freshly-added keyboard is SELECTED (the premise of the next check)");
  ok((await modeNow()) === null, "…but selecting it did NOT enter play mode");
  await page.keyboard.press("KeyQ");
  await settle();
  ok((await page.evaluate(() => window.__cbNotes.length)) === 0,
    "a SELECTED-but-not-playing keyboard does not swallow typing — Q sounded nothing");
  ok((await litNotes(keyboardId)).length === 0, "…and lit no keys");

  // ── ENTER: DOUBLE-CLICK ──────────────────────────────────────────────────
  // The header strip: unambiguously the node, unambiguously not a piano key (a
  // double-click on the FACE would also play it by pointer, which would muddy the
  // "typing did this" claim below).
  const header = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const s = app.canvasActions.worldToScreen(n.state.x + n.state.w / 2, n.state.y + 10);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, keyboardId);
  // THE CLICK POINT IS NOT COVERED — asserted rather than assumed, because the
  // one time it was covered (the boot splash, see the readiness wait above) the
  // symptom was six failing assertions that all read as "double-click is broken".
  // A named check turns that half-hour into one line.
  const atPoint = await page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    if (!e) return "nothing";
    // `className` on an SVG element is an SVGAnimatedString, not a string, so the
    // naive `String(e.className)` prints "[object SVGAnimatedString]". `classList`
    // is the form that reads the same on both.
    return `${e.tagName}${e.classList[0] ? "." + e.classList[0] : ""}`;
  }, header);
  ok(!/boot-stages|splash/i.test(atPoint), `the keyboard's header is the topmost element at the click point (got ${atPoint})`);

  await page.mouse.click(header.x, header.y, { clickCount: 2 });
  await settle();
  const entered = await modeNow();
  ok(entered?.handlerId === "keyboard_play", `double-clicking the keyboard entered play mode (got ${JSON.stringify(entered)})`);
  ok(entered?.itemId === keyboardId, "…on the keyboard that was double-clicked");

  // ── a + b. A REAL KEYDOWN LIGHTS THE KEY AND FIRES THE NOTE ──────────────
  // page.keyboard.down is a REAL CDP key event, not a synthetic dispatch —
  // WORKSTREAM BW recorded a synthetic-dispatch probe passing as a FALSE NEGATIVE,
  // so the input has to be the browser's own.
  //
  // Z is the mapping's origin: VoiceThing's piano.py gives it the keyboard's
  // lowest C, semitone 0 above base.
  await page.keyboard.down("KeyZ");
  await settle();
  const litZ = await litNotes(keyboardId);
  ok(litZ.length === 1 && litZ[0] === baseNote,
    `(a) typing Z LIT the piano key it plays — the reported defect (lit ${JSON.stringify(litZ)}, expected [${baseNote}])`);
  const firedZ = await page.evaluate(() => window.__cbNotes.filter((n) => n.phase === "on"));
  ok(firedZ.length === 1 && firedZ[0].note === baseNote && firedZ[0].itemId === keyboardId,
    `(b) …and FIRED that note into the audio path (${JSON.stringify(firedZ)})`);

  // AUTO-REPEAT MUST NOT RETRIGGER. Holding a key fires keydown ~30/s; re-sounding
  // would buzz the envelope and steal the note's own poly voice.
  await page.keyboard.down("KeyZ");
  await settle(120);
  ok((await page.evaluate(() => window.__cbNotes.filter((n) => n.phase === "on").length)) === 1,
    "a repeated keydown for a held key does NOT retrigger the note");

  // A SECOND KEY SOUNDS TOO, and both stay lit: this is the polyphony the founding
  // message called important ("Polyphonic demos are important").
  await page.keyboard.down("KeyX");
  await settle();
  const litBoth = await litNotes(keyboardId);
  ok(litBoth.length === 2 && litBoth[0] === baseNote && litBoth[1] === baseNote + 2,
    `two held keys light two piano keys — X is a whole tone above Z (${JSON.stringify(litBoth)})`);

  // RELEASE UN-LIGHTS AND NOTE-OFFS.
  await page.keyboard.up("KeyZ");
  await settle();
  const litAfterUp = await litNotes(keyboardId);
  ok(litAfterUp.length === 1 && litAfterUp[0] === baseNote + 2,
    `releasing Z un-lit only Z (${JSON.stringify(litAfterUp)})`);
  ok((await page.evaluate((n) => window.__cbNotes.some((e) => e.phase === "off" && e.note === n), baseNote)),
    "…and sent its note-off");

  // ── d. ESCAPE EXITS, AND TAKES THE HELD CHORD WITH IT ────────────────────
  // X is still down. A mode that left it ringing would leave a drone with no
  // visible source — exactly what releaseAllLiveNotes exists to prevent.
  await page.keyboard.press("Escape");
  await settle();
  ok((await modeNow()) === null, "(d) Escape left play mode");
  ok((await litNotes(keyboardId)).length === 0, "…un-lighting every held key");
  ok((await page.evaluate((n) => window.__cbNotes.some((e) => e.phase === "off" && e.note === n), baseNote + 2)),
    "…and releasing the note still held at exit (no orphan drone)");

  // AND TYPING IS GIVEN BACK. The complement of claim (c): after the mode ends the
  // alphabet means what it always meant.
  const notesBefore = await page.evaluate(() => window.__cbNotes.length);
  await page.keyboard.press("KeyQ");
  await settle();
  ok((await page.evaluate(() => window.__cbNotes.length)) === notesBefore,
    "after exit, Q no longer plays — the alphabet is handed back");

  const realLiveErrors = liveErrors.filter((e) => !knownBootNoise.test(e));
  ok(realLiveErrors.length === 0, `no unexpected console errors during the session (${JSON.stringify(realLiveErrors.slice(0, 4))})`);
} catch (e) {
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
console.log(`\nkeyboard_play_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
if (errors.length) { for (const e of errors) console.error(e); process.exit(1); }
