/**
 * A RENDER MAY NOT SHIP A HOLE — the browser gate for R6-12.1, "the video widget
 * does not appear in Render Center output at all".
 *
 * ── THE DEFECT, MEASURED TWICE ────────────────────────────────────────────────
 * A `video` (or `video_scrub`) whose source fails to load drew NOTHING and the
 * render job SUCCEEDED. The mechanism is a two-way partition with a third case in
 * it: `pendingVideoSrcs()` selects only "loading", deliberately, so an errored src
 * is never pending; `web/renderJobPage.js settledFrame` treated "nothing pending"
 * as "the frame is whole"; `sceneMedia` left the ref out of the media map; and
 * `paint_skia`'s `if (!img) break;` skipped the quad. Result: a frame of bare
 * camera background, written to disk, at exit 0
 * (.frenzy/round6/W5A-shots/badsrc_hole.png, and wave 1's H_badplayer_hole.png).
 * Nothing above the registry's own console.error said the picture was wrong, which
 * is why a user only finds out after the render.
 *
 * ── WHAT THIS PROBE PINS, AND WHY IT NEEDS A BROWSER ──────────────────────────
 * The failure only exists where there is a real `<video>` element to fail: bare
 * node has none, so no node suite can hold this still. So this drives the ACTUAL
 * render-job protocol — the same Vite dev server, the same `?cli=1` page, the same
 * `/renderJobPage.js` import, the same `__powerrp_renderJobOpen` /
 * `__powerrp_renderJobFrame` globals that cli/render_job.js drives over CDP.
 *
 * Three phases, and all three are needed because two of them are the ways a fix
 * can be worse than the bug:
 *   1. BROKEN — a deck whose video src 404s must REJECT, naming the src. (Before
 *      the fix it resolved with a base64 PNG of a hole.)
 *   2. GOOD — the same deck on a real clip must still resolve. A gate that refuses
 *      every render is not a fix.
 *   3. UNSOURCED — a video widget with no source chosen must still render. This is
 *      the C-19 pairing: refusing a failed source and defaulting `src` to a PNG a
 *      `<video>` rejects are individually reasonable and together mean "insert a
 *      video widget, don't pick a clip yet, hit Render" fails every render.
 *
 * Run:  node src/demo_apps/PowerRP/tests/render_job_media_hole_probe.js
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const PAGE_MODULE_URL = "/renderJobPage.js"; // the same module cli/render_job.js imports into the page
const BROKEN_SRC = "/asset/NoSuchProjectW5A/nope.mp4"; // 404s through the dev server's asset proxy
const W = 240, H = 180;
/** One output frame: no transitions, and a hold of one frame at 1 fps. */
const PARAMS = { width: W, height: H, fps: 1, background: "#000000", samples: 1, startIndex: 0, endIndex: 0, includeTransitions: false, holdSeconds: 1 };

const mp4 = await readFile(resolve(HERE, "fixtures/scrub_video.mp4"));
const GOOD_SRC = `data:video/mp4;base64,${mp4.toString("base64")}`;

/**
 * Pure function. A one-slide deck with a camera, a control rect, and the video
 * items given. `items` is spread over the slide-0 delta, so a phase decides
 * exactly which video widgets exist and how they are sourced.
 *
 * @param {object} items id → item state
 * @returns {object} a serializable document
 *
 * @example // deck({v: {type: "video", src: "clip.mp4", x: 0, y: 40, w: 240, h: 100, z: 1, rotation: 0, scale: 1, active: true}})
 * // {meta: {...}, slides: [{id: "s0", ...}]}
 */
function deck(items) {
  return {
    meta: { name: "w5a-hole", slideW: W, slideH: H },
    slides: [{
      id: "s0", name: "A", transition: { type: "fade", seconds: 1 },
      delta: {
        items: {
          cam: { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: "#222222" },
          ctl: { type: "rect", name: "Control", x: 0, y: 0, w: W, h: 30, z: 5, rotation: 0, scale: 1, active: true, fill: "#ffff00" },
          ...items,
        },
        vars: {},
      },
    }],
  };
}

/** Pure function. A video-family item box, stacked under the control rect. */
const box = (type, extra) => ({ type, x: 0, y: 40, w: W, h: 100, z: 1, rotation: 0, scale: 1, active: true, ...extra });

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
// Settle the dep optimizer before Chrome navigates — cli/render_job.js does the
// same, for the same reason: the page module is fetched exactly once, so a single
// "504 Outdated Optimize Dep" is fatal.
await server.warmupRequest(PAGE_MODULE_URL);
await server.waitForRequestsIdle();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

let checks = 0;
let failed = false;
function ok(label) { checks++; console.log(`PASS  ${label}`); }
function bad(label, detail) { failed = true; console.error(`FAIL  ${label}\n      ${detail}`); }

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { console.error("pageerror:", e.message); failed = true; });
  await page.goto(`${baseUrl}/?cli=1`, { waitUntil: "load", timeout: 60000 });
  await page.evaluate((mod) => import(mod), PAGE_MODULE_URL);
  await page.waitForFunction("!!window.__powerrp_renderJobOpen", { timeout: 60000 });

  /**
   * Command (async; renders in the page). Opens a session on `doc`, asks for frame
   * 0, closes. Returns {ok, error, bytes} — never throws for a render failure, so a
   * phase can assert on either outcome. `bytes` is the base64 length, a cheap
   * "a PNG came back" signal.
   */
  const renderOne = (doc) => page.evaluate(async (docJson, params) => {
    try {
      await window.__powerrp_renderJobOpen(docJson, params);
      const b64 = await window.__powerrp_renderJobFrame(0);
      return { ok: true, error: null, bytes: b64.length };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), bytes: 0 };
    } finally {
      window.__powerrp_renderJobClose();
    }
  }, JSON.stringify(doc), PARAMS);

  // ── PHASE 1: a broken source must REFUSE the frame, naming the src ───────────
  for (const [label, items] of [
    ["player", { v: box("video", { src: BROKEN_SRC }) }],
    ["scrubber", { v: box("video_scrub", { src: BROKEN_SRC, scrubTime: 1.5, scrubWrap: "clamp" }) }],
  ]) {
    const r = await renderOne(deck(items));
    if (r.ok) bad(`a broken ${label} source refuses the frame`, `the render SUCCEEDED (${r.bytes} base64 chars) — that PNG has a hole in it`);
    else if (!r.error.includes(BROKEN_SRC)) bad(`a broken ${label} source refuses the frame`, `it failed, but the message does not name the src: ${r.error}`);
    else ok(`a broken ${label} source refuses the frame and names it`);
  }

  // ── PHASE 2: a working deck must still render (no false positive) ────────────
  {
    const r = await renderOne(deck({
      p: box("video", { src: GOOD_SRC, h: 50 }),
      s: { ...box("video_scrub", { src: GOOD_SRC, scrubTime: 1.5, scrubWrap: "clamp" }), y: 100, h: 50, z: 2 },
    }));
    if (!r.ok) bad("a working player + scrubber deck still renders", `it was refused: ${r.error}`);
    else ok(`a working player + scrubber deck still renders (${r.bytes} base64 chars)`);
  }

  // ── PHASE 3: an UNSOURCED widget must still render ───────────────────────────
  // No `src` key at all, so repairedDocument fills each from its plugin default.
  // If that default is ever an image data URI again, phase 1's refusal turns every
  // freshly inserted video widget into a failed render — which is why these two
  // changes are one change.
  {
    const r = await renderOne(deck({
      p: box("video", { h: 30 }),
      s: { ...box("video_scrub"), y: 80, h: 30, z: 2 },
      t: { ...box("demo_video_time_scrub"), y: 120, h: 30, z: 3 },
    }));
    if (!r.ok) bad("unsourced video widgets still render", `it was refused: ${r.error}`);
    else ok(`unsourced video widgets still render (${r.bytes} base64 chars)`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) { console.error(`\nrender_job_media_hole_probe: FAILED (${checks} checks passed before the failure)`); process.exit(1); }
console.log(`\nrender_job_media_hole_probe: ${checks} checks passed`);
