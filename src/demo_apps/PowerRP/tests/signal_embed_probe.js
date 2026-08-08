/**
 * THE EMBEDDED `signal` EDITOR, in a real browser.
 * Run: node src/demo_apps/PowerRP/tests/signal_embed_probe.js
 *
 * ── WHAT THIS ASKS THAT A UNIT TEST CANNOT ──────────────────────────────────
 * core/signal_song.js's conversion arithmetic is pinned in bare node
 * (tests/signal_song_test.js) against hand-built SMF bytes, deliberately — so this
 * probe does NOT re-derive it. It asks only the questions that need a browser, and
 * each one is a way this feature could be completely dead while every bare-node
 * test stayed green:
 *
 *   1. DOES DOUBLE-CLICK OPEN IT? The ACTIVATE registry, CanvasView's dispatch, the
 *      app signal and App.svelte's mount are four separate links and no unit test
 *      sees any of them. The migration gate can only prove the DECLARATION exists,
 *      never that the chain runs.
 *   2. IS THE REAL `signal` ACTUALLY IN THE FRAME? This is THE question of the whole
 *      integration, because the failure it guards against is the one that already
 *      happened once: a hand-written lookalike in place of the real application
 *      (user, on the previous attempt: "this little chicken shit 'midi clip'
 *      temu-quality 'we have signal at home' widget"). So the probe reaches INTO
 *      the frame and asserts signal's OWN DOM is there — a src attribute pointing
 *      at a 404, or at our own markup, would pass every other check here.
 *   3. IS IT STYLED? web/ components carry no <style> block, so every rule is in
 *      app.css and a missing one is invisible until it renders. A zero-height
 *      iframe is a fully-wired editor nobody can see.
 *   4. DOES THE AUTHORING SEAM REACH THE DOCUMENT? localStorage → conversion →
 *      `clip` + `ctrl` leaves → one undo unit. The conversion is unit-tested; that
 *      it is WIRED to the store is not, and cannot be.
 *
 * ── THE TRAP THIS PROBE IS BUILT AROUND ────────────────────────────────────
 * WebSurge's manifest records it from their own integration: a test that clicks
 * signal's transport at PAGE coordinates can hit whatever the host page has
 * floating over the frame and produce a note — which looks exactly like success.
 * So every assertion about signal itself is evaluated INSIDE the frame
 * (`frame.evaluate`), never by aiming the mouse at page coordinates.
 *
 * ── WHY THE PROBE WRITES THE AUTOSAVE ITSELF ───────────────────────────────
 * signal autosaves on a 10-SECOND interval and only while its song is dirty, so a
 * probe that drew a note and waited would take >10 s and be flaky on a loaded host.
 * It writes the same envelope signal writes — a base64 SMF under
 * `signal_autosave` — which is exactly the contract core/signal_song.js is coupled
 * to. Check 2 is what keeps that honest: it proves the real app is running and
 * therefore that the key is really the key it uses.
 */

import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

// hmr: false — a sibling agent's save mid-run would reload the page and destroy the
// execution context (tests/list_ui_probe.js's measured reason).
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();

const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A one-note-plus-one-bend SMF at 480 ppq, as signal's autosave envelope. Built
 *  here rather than imported so this file states the exact bytes it feeds in. */
function autosaveEnvelope() {
  const varint = (n) => { const o = [n & 0x7f]; let v = n >> 7; while (v > 0) { o.unshift((v & 0x7f) | 0x80); v >>= 7; } return o; };
  const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
  const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const events = [
    [0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20], // setTempo 500000us → 120 BPM
    [0, 0xe0, 0x00, 0x60],                   // pitch bend 12288
    [0, 0x90, 60, 100],                      // note on  C4
    [480, 0x80, 60, 0],                      // note off C4 one beat later
  ];
  const body = [];
  for (const [d, ...b] of events) body.push(...varint(d), ...b);
  body.push(0, 0xff, 0x2f, 0x00);
  const bytes = [
    ...ascii("MThd"), ...u32(6), ...u16(1), ...u16(1), ...u16(480),
    ...ascii("MTrk"), ...u32(body.length), ...body,
  ];
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return JSON.stringify({ midiData: Buffer.from(bin, "binary").toString("base64"), timestamp: Date.now() });
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const liveErrors = [];
  page.on("pageerror", (e) => liveErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // No project backend when this probe is run alone; WebGPU absence is noise.
    if (/\/api\/projects|500 \(Internal Server Error\)|no.*adapter|adapters/i.test(t)) return;
    // SIGNAL'S OWN CONSOLE OUTPUT IS NOT OUR PAGE'S HEALTH. A framed page's errors
    // arrive on the same CDP connection, so without this the probe would report
    // ryohey's Radix a11y advisory as a PowerRP regression — and, worse, would go
    // red the day they add any warning of their own, in a file we do not write and
    // must not patch. Matched NARROWLY (this exact advisory) rather than by frame
    // origin: a genuine failure to LOAD signal must still be caught, and checks 2's
    // in-frame DOM assertions are what catch it.
    if (/DialogContent.*requires a .?DialogTitle/s.test(t)) return;
    liveErrors.push(`console.error: ${t}`);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("boot-splash") === null, { timeout: 120000 });
  const settle = (ms = 220) => sleep(ms);

  /** Query. ROUND-TRIPPED THROUGH JSON INSIDE THE PAGE. Load-bearing: the evaluated
   *  state is Svelte 5 `$state`, a deep PROXY, and CDP's serializer does not see a
   *  Proxy over an Array as an array — a clip would arrive as `{"0": …}` and every
   *  `.length` on it would fail, reading exactly like a broken feature
   *  (tests/note_latch_probe.js measured this and records it at length). */
  const leafOf = (id, key) => page.evaluate(
    (id, key) => JSON.parse(JSON.stringify(window.__powerrp_app.state().items[id]?.[key] ?? null)), id, key);

  // ── A SIGNAL NODE ON THE CANVAS ───────────────────────────────────────────
  const id = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get("node_midi_clip").defaults, x: 200, y: 200 });
    return app.selection;
  });
  await settle(400);
  ok(!!id, "a Signal node can be inserted");
  ok(JSON.stringify(await leafOf(id, "clip")) === "[]", "a fresh Signal node holds the empty stream");

  // ── 1. DOUBLE-CLICK OPENS IT (the whole ACTIVATE chain, end to end) ───────
  const onWidget = await page.evaluate((id) => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((x) => x.itemId === id);
    const s = app.canvasActions.worldToScreen(n.state.x + 40, n.state.y + 20);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, id);
  await page.mouse.click(onWidget.x, onWidget.y, { clickCount: 2 });
  await settle(600);
  ok(await page.evaluate(() => !!document.querySelector(".sig-root")),
    "DOUBLE-CLICKING the widget opens the signal editor");
  ok(await page.evaluate(() => !!window.__powerrp_signal), "the modal publishes its test seam");
  // role="dialog" is what stands the canvas shortcuts down — otherwise a keystroke
  // meant for signal would also reach the canvas.
  ok(await page.evaluate(() => !!document.querySelector('.modal-panel[role="dialog"] .sig-root')),
    "it is a real dialog, so the canvas shortcuts stand down while it is open");

  // ── 2. THE REAL `signal` IS IN THE FRAME ──────────────────────────────────
  // THE CENTRAL CHECK OF THIS FILE. See the header: a lookalike is the failure
  // mode this whole workstream exists to undo, and only the frame's own DOM can
  // distinguish "we vendored and framed their application" from "we drew one".
  const src = await page.evaluate(() => window.__powerrp_signal.frameSrc());
  ok(/signal\/edit\.html$/.test(src ?? ""), `the frame points at the vendored editor (${src})`);

  const frameHandle = await page.$(".sig-frame");
  const frame = await frameHandle?.contentFrame();
  ok(!!frame, "the iframe has a reachable content frame (same-origin)");

  let signalDom = null;
  if (frame) {
    // signal is a React app that mounts into #root and pulls a WebGL canvas up.
    // Waiting on #root having CHILDREN is waiting on the 2.35 MB bundle to have
    // evaluated and rendered — not merely on the document existing.
    try {
      await frame.waitForFunction(() => document.querySelector("#root")?.children.length > 0, { timeout: 60000 });
    } catch { /* reported by the check below, with what was actually found */ }
    signalDom = await frame.evaluate(() => ({
      title: document.title,
      hasRoot: !!document.querySelector("#root"),
      rootChildren: document.querySelector("#root")?.children.length ?? 0,
      canvases: document.querySelectorAll("canvas").length,
      // The one unambiguous fingerprint: signal's own autosave keys, written by
      // its bundle and by nothing of ours.
      bodyText: (document.body.innerText || "").slice(0, 200),
    }));
  }
  ok(signalDom?.hasRoot, "the framed page is signal's own document (it has signal's #root)");
  ok((signalDom?.rootChildren ?? 0) > 0,
    `signal's 2.35 MB bundle EVALUATED and rendered (#root has ${signalDom?.rootChildren ?? 0} children)`);
  ok((signalDom?.canvases ?? 0) > 0,
    `signal's WebGL piano roll put a canvas on the page (${signalDom?.canvases ?? 0} canvases)`);

  // ── 3. IT IS ACTUALLY STYLED (no <style> blocks in web/ — app.css or nothing) ──
  const layout = await page.evaluate(() => {
    const f = document.querySelector(".sig-frame");
    const bar = document.querySelector(".sig-toolbar");
    const r = f?.getBoundingClientRect();
    return { fw: r?.width ?? 0, fh: r?.height ?? 0, barH: bar?.getBoundingClientRect().height ?? 0 };
  });
  ok(layout.fw > 600 && layout.fh > 300,
    `the frame fills the dialog (${Math.round(layout.fw)}x${Math.round(layout.fh)}) — a missing app.css rule collapses it`);
  ok(layout.barH > 10, `the toolbar is laid out (${Math.round(layout.barH)}px tall)`);

  // ── 4. THE AUTHORING SEAM REACHES THE DOCUMENT ────────────────────────────
  // Write the envelope signal writes, then drive the modal's own reader — the same
  // code path the Import button uses, not a reimplementation of it.
  await page.evaluate((raw) => window.localStorage.setItem("signal_autosave", raw), autosaveEnvelope());
  const snap = await page.evaluate(() => window.__powerrp_signal.poll());
  ok((snap?.bytes ?? 0) > 0, "the modal picks up signal's autosave from localStorage");

  await page.evaluate(() => window.__powerrp_signal.importSong());
  await settle(350);
  const clip = await leafOf(id, "clip");
  const ctrl = await leafOf(id, "ctrl");
  ok(Array.isArray(clip) && clip.length === 1, `the imported NOTE reached the document (${JSON.stringify(clip)})`);
  ok(clip?.[0]?.[2] === 60 && clip?.[0]?.[1] === 1,
    "…at the right pitch and a full beat long, so ticks really became beats");
  // THE HALF WEBSURGE DROPPED. Their bridge is note-only and their manifest calls
  // that their biggest gap; a bend that vanished here would be that gap shipped on.
  ok(Array.isArray(ctrl) && ctrl.length === 1, `the imported PITCH BEND reached the document (${JSON.stringify(ctrl)})`);
  ok(ctrl?.[0]?.[1] === -1 && ctrl?.[0]?.[2] === 12288, "…as a bend sentinel at its 14-bit value");
  ok(/Imported 1 note/.test(await page.evaluate(() => window.__powerrp_signal.footer())),
    "the modal SAYS what it imported");

  // ── ONE IMPORT IS ONE UNDO UNIT ───────────────────────────────────────────
  // Measured by undoing ONCE and checking BOTH leaves came all the way back, which
  // is the property that matters and is stronger than counting a stack.
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(300);
  ok(JSON.stringify(await leafOf(id, "clip")) === "[]" && JSON.stringify(await leafOf(id, "ctrl")) === "[]",
    "ONE undo reverses the whole import — notes and automation together");

  // ── CLOSING RETIRES EVERYTHING ────────────────────────────────────────────
  await page.evaluate(() => window.__powerrp_signal.close());
  await settle(300);
  ok(await page.evaluate(() => !document.querySelector(".sig-root")), "closing removes the editor");
  ok(await page.evaluate(() => !window.__powerrp_signal), "…and retires its test seam");

  ok(liveErrors.length === 0, `no page errors (${liveErrors.slice(0, 3).join(" | ")})`);
} catch (e) {
  // A THROW MUST NOT SWALLOW THE CHECKS ALREADY MADE (tests/note_latch_probe.js's
  // rule): report what passed, then the failure.
  errors.push(`THREW: ${e.stack || e.message}`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "  ok  " : "  FAIL"} ${label}`);
if (errors.length) {
  console.log(`\nFAILURES (${errors.length}):`);
  for (const e of errors) console.log(`  ${e}`);
}
console.log(`\nsignal_embed_probe: ${checks.filter(([p]) => p).length}/${checks.length} checks passed`);
process.exit(errors.length ? 1 : 0);
