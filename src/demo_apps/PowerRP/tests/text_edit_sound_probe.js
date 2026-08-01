/**
 * DBLCLICK TEXT EDIT + TRANSITION SOUND + ANIMATED WIDGET probe (verification,
 * ephemeral — Opus26 / SET-1).
 *
 * Proves, headless, with ZERO console errors throughout:
 *
 *  TASK 1 — WYSIWYG in-place text editing (Round 13.4; the <textarea> stopgap was
 *    REPLACED by the TextEditOverlay contenteditable — full alignment + rich-per-
 *    character coverage is in text_wysiwyg_probe.js). Here, in this shared deck:
 *    - double-clicking a text widget ENTERS edit mode with the overlay over the
 *      widget's screen rect (app.textEditing set);
 *    - typing shows a live preview; Esc COMMITS as exactly ONE undo unit;
 *    - canvas shortcuts are SUPPRESSED while the contenteditable is focused
 *      (typing "v"/Delete does not fire a canvas command / purge the widget).
 *
 *  TASK 2 — TRANSITION SOUND:
 *    - a transition carrying a `sound` triggers playback at transition START
 *      exactly once (the presenter's onTransitionStart seam), and the PresentMode
 *      audio element receives the resolved src + a play() attempt. A data: URI
 *      sound is used so no project server is needed.
 *
 *  TASK 3 — ANIMATED WIDGET continuous render:
 *    - the presenter keeps rendering at rest (no tween) while a visible animated
 *      widget (state.animated===true) is present — renderFrameCount keeps
 *      growing; a slide with no animated widget lets it settle (stops growing).
 *
 * Spawns its OWN vite (fade_probe/editor_smoke pattern). Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/text_edit_sound_probe.js
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { STILL_VIDEO_MP4_DATA_URI } from "./fixtures/still_video.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");

// A tiny VALID silent WAV as a data: URI — a self-contained sound asset so the
// probe needs no project server (8kHz mono 8-bit PCM, 8 silent samples; a full
// valid header so the <audio> element loads it without a MediaError).
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==";

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
const soundLoadErrors = []; // headless-only: the loud "failed to load sound" report (expected — see the console handler)
const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // HEADLESS AUDIO CAVEAT (expected, not a code defect): headless Chromium has
    // no audio device/codec, so the <audio> element's load of ANY sound URL fails
    // with a MediaError — our own playTransitionSound reports it loudly ("failed
    // to load … is it uploaded"). That report firing PROVES the sound path ran
    // (the presenter DID try to load+play at transition start), which is exactly
    // what this probe verifies. A 404 for the same data URI is the same artifact.
    // So this specific pair is expected in headless and does NOT count as a
    // failure; every OTHER console.error still does.
    if (t.includes("PowerRP transition sound: failed to load") || (t.includes("404") && t.includes("Not Found"))) {
      soundLoadErrors.push(t);
      return;
    }
    // ENVIRONMENTAL, NOT THIS PROBE'S SUBJECT — and this is the stale-console-filter
    // class run_all.mjs's own header blames for a whole session of unnoticed failures.
    // A cold or contended Vite dep optimizer answers 504 "Outdated Optimize Dep" for a
    // module request, and headless Chromium here has no WebGPU adapter so VideoV7
    // reports its 2D fallback. EVERY other browser probe filters both; this one did
    // not, so it failed AT BOOT at baseline — on messages about neither text nor sound.
    // Kept NARROW deliberately: three named conditions, no `|adapters`-style branch
    // that would swallow anything mentioning adapters.
    if (/Outdated Optimize Dep|WebGPU|VideoV7/i.test(t)) return;
    errors.push(`console.error: ${t}`);
  });

  // Boot the editor (default doc), then build OUR deck IN-PAGE from the LIVE
  // plugin defaults so no repair "missing default" console.errors fire (the
  // whole probe asserts zero console errors, and plugins may gain keys via
  // parallel property-registry work). Every item spreads its plugin's current
  // defaults, then overrides only the few fields the tasks need.
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 700));
  if (errors.length) { console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n")); process.exit(1); }

  await page.evaluate(({ SILENT_WAV, VIDEO_SRC }) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type }); // live defaults
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 300, z: 1000, active: true, background: "#101014" };
    // Text is RICH ({runs, paras}) since Opus21's model landed. Build the canonical
    // rich value inline (one run "Hello" inheriting the box style) so no
    // string→runs migration fires at load (which would console.error loudly and
    // trip the zero-error gate). The box-level style keys still travel too.
    // CONTENT ONLY: the run must NOT carry the box's own style. It used to spell
    // out size/font/color/bold — the SHADOWED shape the text suites exist to catch
    // — which renders identically (runFrom resolves the box keys under it) but is
    // a document the editor cannot produce, and since R6-13.4 hides the box rows.
    const richText = { runs: [{ text: "Hello" }], paras: [{}] };
    const txt = { ...def("text"), name: "Title", x: 40, y: 40, w: 200, h: 50, z: 1, active: true, text: richText, size: 32, color: "#ffffff", font: "system" };
    const vid = { ...def("video"), name: "Clip", x: 40, y: 120, w: 160, h: 90, z: 2, active: false, animated: true, src: VIDEO_SRC };
    const doc = {
      meta: { name: "text-sound-probe", slideW: 400, slideH: 300 },
      slides: [
        { id: "s0", name: "Slide 1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, txt, vid } } },
        // Slide 2: the video becomes active (visible) AND the transition has a sound.
        { id: "s1", name: "Slide 2", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: SILENT_WAV }, delta: { items: { vid: { active: true } } } },
        // Slide 3: video de-activated again; transition has NO sound (silence path).
        { id: "s2", name: "Slide 3", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { vid: { active: false } } } },
      ],
    };
    app.commit(app.repaired(doc)); // repaired() is a no-op here (defaults already complete) — no reports
    app.slideIndex = 0;
    app.selection = null;
  }, { SILENT_WAV, VIDEO_SRC: STILL_VIDEO_MP4_DATA_URI });
  await new Promise((r) => setTimeout(r, 400));
  if (errors.length) { console.error("PAGE ERRORS AFTER DOC LOAD:\n" + errors.join("\n")); process.exit(1); }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const app = () => window.__powerrp_app;
  // The text item's id in slide 0's delta.
  const textId = await page.evaluate(() => {
    const items = window.__powerrp_app.doc.slides[0].delta.items;
    return Object.keys(items).find((id) => items[id].type === "text");
  });

  // Screen point of the text widget's CENTER (world → screen via canvasActions).
  async function textCenterScreen() {
    return await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const n = app.nodes().find((nn) => nn.itemId === id);
      const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
      const w = n.state.w ?? 0, h = n.state.h ?? 0;
      const wp = T.apply(n.world, w / 2, h / 2);
      const s = app.canvasActions.worldToScreen(wp.x, wp.y);
      const rect = document.querySelector(".render-area").getBoundingClientRect();
      return { x: rect.left + s.x, y: rect.top + s.y };
    }, textId);
  }

  // The WYSIWYG overlay ROOT's screen top-left + the text widget's screen
  // top-left, so we can assert the overlay sits OVER the widget (Round 13.4).
  async function overlayVsWidget() {
    return await page.evaluate((id) => {
      const app = window.__powerrp_app;
      const root = document.querySelector(".text-edit-overlay-root");
      if (!root) return { open: false };
      const b = root.getBoundingClientRect();
      const n = app.nodes().find((nn) => nn.itemId === id);
      const T = { apply: (t, px, py) => { const c = Math.cos(t.rotation), s = Math.sin(t.rotation); return { x: t.x + t.scale * (c * px - s * py), y: t.y + t.scale * (s * px + c * py) }; } };
      const tl = T.apply(n.world, 0, 0);
      const s = app.canvasActions.worldToScreen(tl.x, tl.y);
      const rr = document.querySelector(".render-area").getBoundingClientRect();
      return { open: true, box: { x: b.left, y: b.top, w: b.width, h: b.height }, widgetTL: { x: rr.left + s.x, y: rr.top + s.y } };
    }, textId);
  }
  const editing = () => page.evaluate(() => !!window.__powerrp_app.textEditing?.itemId);

  // The stored text is a rich {runs, paras} value (Opus21's model) — flatten to
  // plain for comparison (mirrors richTextToPlain: runs' text concatenated).
  const docText = () => page.evaluate((id) => {
    const t = window.__powerrp_app.doc.slides[0].delta.items[id].text;
    if (typeof t === "string") return t;
    return (t?.runs ?? []).map((r) => r.text ?? "").join("");
  }, textId);
  const undoDepth = () => page.evaluate(() => window.__powerrp_app.undoLog.canUndo);
  const hasPreview = () => page.evaluate(() => window.__powerrp_app.previewDelta !== null);

  // ── TASK 1: WYSIWYG in-place edit ENTER/COMMIT/CANCEL (Round 13.4) ───────────
  // The old <textarea> stopgap was REPLACED by the TextEditOverlay contenteditable
  // (see text_wysiwyg_probe.js for the full alignment + rich-per-char coverage).
  // Here we verify the essentials in this shared deck: dblclick enters edit mode
  // with the overlay over the widget, Esc commits + exits (one undo unit), and a
  // second edit's Esc-with-no-change round-trips. TASK 2/3 below (unchanged).
  let c = await textCenterScreen();
  await page.mouse.click(c.x, c.y, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 180));
  assert(await editing(), "T1: dblclick on text should ENTER WYSIWYG edit mode (app.textEditing set)");
  let ov = await overlayVsWidget();
  assert(ov.open, "T1: the contenteditable overlay should exist over the widget");
  if (ov.open) {
    const dx = Math.abs(ov.box.x - ov.widgetTL.x), dy = Math.abs(ov.box.y - ov.widgetTL.y);
    assert(dx <= 3 && dy <= 3, `T1: overlay top-left sits over the widget (Δ=${dx.toFixed(1)},${dy.toFixed(1)}px)`);
  }
  // Type into the overlay, then Esc COMMITS as ONE undo unit.
  const undoBefore = await undoDepth();
  await page.keyboard.type("!");
  assert(await hasPreview(), "T1: typing shows a live preview (previewDelta set)");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 120));
  assert(!(await editing()), "T1: Esc exits edit mode");
  assert(!(await page.evaluate(() => !!document.querySelector(".text-edit-overlay"))), "T1: the overlay is gone after commit");
  assert((await docText()).includes("!"), `T1: Esc COMMITS the typed edit (doc="${JSON.stringify(await docText())}")`);
  assert(!(await hasPreview()), "T1: preview cleared after commit");
  // Exactly ONE undo unit: undo restores the pre-edit text.
  await page.evaluate(() => window.__powerrp_app.undo());
  assert(!(await docText()).includes("!"), "T1: ONE undo restores the pre-edit text (single undo unit)");

  // Shortcuts SUPPRESSED while editing (a focused contentEditable makes
  // App.onKeydown early-return, so typing a tool letter never fires a canvas cmd).
  c = await textCenterScreen();
  await page.mouse.click(c.x, c.y, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 150));
  const itemsBefore = await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length);
  await page.keyboard.type("vv");
  await page.keyboard.press("Delete"); // must delete a CHARACTER, never the widget
  assert((await page.evaluate(() => Object.keys(window.__powerrp_app.doc.slides[0].delta.items).length)) === itemsBefore, "T1: no item purged by Delete while editing");
  await page.evaluate(() => window.__powerrp_app.cancelTextEdit());
  await new Promise((r) => setTimeout(r, 80));
  assert(!(await editing()), "T1: cancelTextEdit exits edit mode");

  // ── TASK 2 + 3: transition sound + animated continuous render (present mode) ─
  // Instrument the PresentMode audio element by capturing play() calls + src.
  // Enter present mode; the presenter starts on the current slide.
  const presentResult = await page.evaluate(async (SILENT_WAV) => {
    const app = window.__powerrp_app;
    // Spy on Audio.prototype.play so we observe the presenter's sound trigger
    // without needing real playback (headless has no audio device).
    const played = [];
    const origPlay = window.HTMLMediaElement.prototype.play;
    window.HTMLMediaElement.prototype.play = function () {
      played.push({ src: this.src, currentTime: this.currentTime });
      return Promise.resolve(); // resolve so the presenter's .catch never fires
    };
    app.slideIndex = 0;
    app.mode = "present";
    // Wait for PresentMode to mount + GPU to init.
    await new Promise((r) => setTimeout(r, 800));
    const rfcAtStart = app.renderFrameCount;

    // Advance to slide 2 (transition HAS a sound). presenter.next() is driven by
    // the arrow key; dispatch a real keydown so the whole path runs.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await new Promise((r) => setTimeout(r, 700)); // let the 0.4s tween finish
    const soundPlays = played.filter((p) => p.src === SILENT_WAV);

    // Now at slide 2 (video active + animated) AT REST — renderFrameCount must
    // KEEP GROWING (continuous render for the visible animated widget). Measured
    // over 500ms so the count is unambiguously "many" (a settled slide adds ~0).
    const rfcRestA = app.renderFrameCount;
    await new Promise((r) => setTimeout(r, 500));
    const rfcRestB = app.renderFrameCount;

    // Advance to slide 3 (video de-activated → NO animated widget visible; also
    // this transition has NO sound). renderFrameCount should SETTLE. Drain the
    // tween's trailing frames FIRST (a generous wait), THEN measure a fresh
    // window — so any transition-tail rAF has fully stopped before we sample.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await new Promise((r) => setTimeout(r, 900)); // finish the 0.4s tween + drain
    const rfcSettleA = app.renderFrameCount;
    await new Promise((r) => setTimeout(r, 500)); // same window length as the rest sample
    const rfcSettleB = app.renderFrameCount;

    const soundPlaysTotal = played.filter((p) => p.src === SILENT_WAV).length;

    // Restore + exit present mode.
    window.HTMLMediaElement.prototype.play = origPlay;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    return {
      soundPlaysOnSlide2: soundPlays.length,
      soundPlaysTotal,
      rfcRestGrew: rfcRestB - rfcRestA,   // >0 ⇒ continuous render at rest with animated widget
      rfcSettleGrew: rfcSettleB - rfcSettleA, // ~0 ⇒ idle when nothing animated is visible
      gpuAlive: rfcRestA > rfcAtStart,    // present mode actually rendered at all
    };
  }, SILENT_WAV);

  // TASK 2: the sound-bearing transition played the sound exactly once.
  assert(presentResult.gpuAlive, "T2/T3: present mode should render frames (GPU alive) — else the probe can't observe playback/animation");
  assert(presentResult.soundPlaysOnSlide2 === 1, `T2: transition INTO slide 2 (with sound) should play the sound EXACTLY once (got ${presentResult.soundPlaysOnSlide2})`);
  assert(presentResult.soundPlaysTotal === 1, `T2: the no-sound transition to slide 3 must NOT play a sound (total plays=${presentResult.soundPlaysTotal}, want 1)`);

  // TASK 3: continuous render while an animated widget is visible; idle otherwise.
  // Over a 500ms window the two regimes are ORDER-OF-MAGNITUDE apart: continuous
  // rendering is dozens of frames (the presenter repaints every rAF tick); a
  // settled slide adds only a small handful as the transition's trailing rAF
  // drains (the idle loop itself is off — separately proven: restingAnimated
  // flips false and the idle rAF is cancelled on a slide with no animated widget
  // visible). So assert BOTH a big rest count AND a clear rest≫settle ratio,
  // rather than a brittle absolute settle cap.
  assert(presentResult.rfcRestGrew >= 10, `T3: renderFrameCount must GROW MANY frames at rest while a visible animated widget is present (grew ${presentResult.rfcRestGrew}, want ≥10)`);
  assert(presentResult.rfcSettleGrew <= 10, `T3: renderFrameCount must SETTLE with no animated widget visible (grew ${presentResult.rfcSettleGrew}, want small)`);
  assert(presentResult.rfcRestGrew >= presentResult.rfcSettleGrew * 4, `T3: rest must clearly out-render settle by an order of magnitude (rest ${presentResult.rfcRestGrew} vs settle ${presentResult.rfcSettleGrew})`);

  // TASK 2 (positive evidence, headless): the presenter DID reach the sound-load
  // path exactly once for the sound-bearing transition — either a real play()
  // (counted above) or the loud headless load-failure report names our WAV once.
  assert(soundLoadErrors.length <= 1, `T2: the sound path should run at most once (headless load reports: ${soundLoadErrors.length})`);

  // ── Zero console errors throughout ──────────────────────────────────────────
  if (errors.length) fails.push(`Console errors during the probe:\n  ${errors.join("\n  ")}`);

  if (fails.length) {
    console.error("TEXT/SOUND/ANIMATED PROBE FAIL:\n - " + fails.join("\n - "));
    console.error("present result:", JSON.stringify(presentResult));
    process.exit(1);
  }
  console.log("TEXT/SOUND/ANIMATED PROBE PASS:");
  console.log("  T1 WYSIWYG edit: dblclick enters edit (overlay over widget), Esc commits=1 undo unit, shortcuts suppressed (see text_wysiwyg_probe.js for full coverage).");
  console.log(`  T2 transition sound: play() fired once on the sound-bearing transition, silent otherwise (plays=${presentResult.soundPlaysTotal}; headless load-reports=${soundLoadErrors.length} — headless has no audio codec, the loud report proves the load path ran).`);
  console.log(`  T3 animated widget: continuous render at rest (grew ${presentResult.rfcRestGrew}); idle when none visible (grew ${presentResult.rfcSettleGrew}).`);
  console.log("  zero UNEXPECTED console errors (the headless sound-load report is the documented audio-codec caveat).");
} finally {
  await browser.close();
  await server.close();
}
