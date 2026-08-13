/**
 * ANIMATED GIFs ARE VIDEOS — the client-side DECISION (workstream GIFVID_).
 *
 * The server transcodes an animated GIF to mp4 during the upload and names the
 * result in the reply's `transcode` block (server.py transcode_uploaded_gif, pinned
 * by tests/gifvid_server_test.py). THIS file pins what the client then does with
 * that reply, which is the half that decides whether the user sees motion:
 *
 *   1. AN ANIMATED GIF INSERTS THE MP4 — kind "video", url pointing at the sibling.
 *      Get this wrong and the transcode is wasted work: the mp4 sits in the library
 *      while the canvas shows the frozen .gif, exactly as before the feature.
 *   2. EVERYTHING ELSE IS BYTE-IDENTICAL to the pre-feature behaviour — a still GIF,
 *      a png, an mp4, a pdf all insert themselves with the caller's own kind.
 *   3. A CLAIM WITHOUT AN MP4 IS NOT ANIMATED. `{animated: true}` with no name/url is
 *      a broken contract, and trusting the flag alone would insert a video widget
 *      pointing at nothing.
 *   4. STATIC MODE SAYS SO. No backend means no ffmpeg means nobody probed the file;
 *      a GIF uploaded there lands as a still WITH a sentence, never silently. And the
 *      sentence is REQUIRED — gifStaticRefusal throws rather than returning a
 *      refusal with nothing in it.
 *
 * WHY BARE NODE: the decision lives in web/gifVideo.js (not inline in the drop
 * handler) precisely so it can be tested with no browser — which is also why that
 * module must not import storageMode.js. Check 5 pins that loadability, because a
 * stray import would silently move this decision back out of test reach.
 *
 * Run: node src/demo_apps/PowerRP/tests/gifvid_kind_test.js
 */
import { insertTargetForUpload, isTranscodedGif, gifStaticRefusal } from "../web/gifVideo.js";

const checks = [];
const ok = (pass, label) => checks.push([pass, label]);
const eq = (a, b, label) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  checks.push([pass, `${label}${pass ? "" : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`]);
};

// The two replies the server actually sends, verbatim in shape.
const ANIMATED = {
  ok: true, name: "spinner.gif", url: "/asset/Deck/spinner.gif",
  transcode: { animated: true, frames: 24, name: "spinner.mp4", url: "/asset/Deck/spinner.mp4" },
};
const STILL = {
  ok: true, name: "logo.gif", url: "/asset/Deck/logo.gif",
  transcode: { animated: false, frames: 1 },
};
const PNG = { ok: true, name: "shot.png", url: "/asset/Deck/shot.png" };
const MP4 = { ok: true, name: "clip.mp4", url: "/asset/Deck/clip.mp4" };
const REASON = "Playing an animated GIF needs a backend to convert it to MP4 with ffmpeg.";

// ── 1. AN ANIMATED GIF INSERTS THE MP4 ──────────────────────────────────────
ok(isTranscodedGif(ANIMATED), "an animated reply naming an mp4 is a transcoded gif");
eq(insertTargetForUpload(ANIMATED, "image"),
   { name: "spinner.mp4", kind: "video", url: "/asset/Deck/spinner.mp4" },
   "an animated GIF inserts its MP4 sibling as a VIDEO");

// ── 2. EVERYTHING ELSE IS UNCHANGED ─────────────────────────────────────────
ok(!isTranscodedGif(STILL), "a single-frame GIF is not a transcoded gif");
eq(insertTargetForUpload(STILL, "image"),
   { name: "logo.gif", kind: "image", url: "/asset/Deck/logo.gif" },
   "a still GIF inserts ITSELF as an image (byte-identical to pre-feature)");
eq(insertTargetForUpload(PNG, "image"),
   { name: "shot.png", kind: "image", url: "/asset/Deck/shot.png" },
   "a png is untouched");
eq(insertTargetForUpload(MP4, "video"),
   { name: "clip.mp4", kind: "video", url: "/asset/Deck/clip.mp4" },
   "an mp4 is untouched");
eq(insertTargetForUpload({ ok: true, name: "p.pdf", url: "/asset/Deck/p.pdf" }, "pdf"),
   { name: "p.pdf", kind: "pdf", url: "/asset/Deck/p.pdf" },
   "a pdf keeps the caller's kind (the registry decides its widget, not this)");
// A STATIC-MODE reply has NO transcode block at all — it must read as "not animated",
// never as a broken animated one.
ok(!isTranscodedGif({ ok: true, name: "spinner.gif", url: "/asset/Deck/spinner.gif" }),
   "a reply with no transcode block (static mode) is not animated");

// ── 3. A CLAIM WITHOUT AN MP4 IS NOT ANIMATED ───────────────────────────────
ok(!isTranscodedGif({ name: "x.gif", transcode: { animated: true, frames: 9 } }),
   "animated:true with NO mp4 name is refused (the flag alone is not evidence)");
ok(!isTranscodedGif({ name: "x.gif", transcode: { animated: true, name: "x.mp4" } }),
   "animated:true with a name but no url is refused");

// ── 4. STATIC MODE SAYS SO ──────────────────────────────────────────────────
const refusal = gifStaticRefusal({ name: "spinner.gif" }, true, REASON);
ok(typeof refusal === "string" && refusal.includes("spinner.gif") && refusal.includes(REASON),
   `a GIF uploaded in static mode is refused BY NAME and with the roster's reason (got ${JSON.stringify(refusal)})`);
ok(gifStaticRefusal(STILL, false, REASON) === null,
   "a still GIF in SERVER mode says nothing (the server probed it — an image is correct)");
ok(gifStaticRefusal(ANIMATED, false, REASON) === null,
   "an animated GIF in server mode says nothing (it became a video)");
ok(gifStaticRefusal(PNG, true, REASON) === null, "a non-GIF in static mode says nothing");
ok(gifStaticRefusal({ name: "SPINNER.GIF" }, true, REASON) !== null,
   "the extension check is case-insensitive");
let threw = null;
try { gifStaticRefusal({ name: "a.gif" }, true, ""); } catch (e) { threw = e; }
ok(threw !== null, "a refusal with NO sentence throws — an empty refusal is the silent frozen GIF");

// ── 5. THE MODULE STAYS BARE-NODE LOADABLE ──────────────────────────────────
// It loaded (this file is running), and that is the assertion: importing
// storageMode.js here would have thrown "location is not defined" at import time.
ok(true, "web/gifVideo.js imports cleanly in bare node (no DOM-reading dependency)");

let failed = 0;
for (const [pass, label] of checks) {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} gif-video kind checks passed`);
if (failed) process.exit(1);
