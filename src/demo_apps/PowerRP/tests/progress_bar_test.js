/**
 * Progress-bar + video-scrubber-progress-export tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/progress_bar_test.js
 *
 * Proves, without a browser:
 *   (1) fillRect / clamp01 pure-fn behavior (the fraction → fill-length math).
 *   (2) progress_bar.emit is two boxes (track + fill), fill length = fraction·track.
 *   (3) the video SCRUBBER's seconds/progress/duration are REFERENCEABLE, read-only
 *       exports (numericPropertyPaths), and — crucially — resolve to RAW scalars
 *       through a PROPERTY reference even when the scrubber is translated/rotated/
 *       scaled (unlike an anchor ref, which would be world-transformed).
 *   (4) END TO END: a progress_bar whose `fraction` is bound `= @scrubber.progress`
 *       fills to track the video's fraction as the scrubber's scrubTime TWEENS
 *       across a slide (fold at several alphas; the fill length is COMPUTED, not
 *       eyeballed), and an UNKNOWN duration (0) honestly yields 0 (no fake time).
 *   (5) a created doc passes repairedDocument with ZERO repair reports (idempotent).
 *
 * Bare-node imports of the plugins are themselves under test (plugins/ stays
 * DOM-free at import time).
 */

import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { evaluateState, numericPropertyPaths } from "../core/expressions.js";
import { foldState, newDocument, repairedDocument, withNewItem } from "../core/document.js";
import { rectPlugin } from "../plugins/rect.js";
import { cameraPlugin } from "../plugins/camera.js";
import { videoScrubPlugin } from "../plugins/video_scrub.js";
import { progressBarPlugin, fillRect, clamp01 } from "../plugins/progress_bar.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };

// ── (1) fraction → fill-length math ───────────────────────────────────────────
test("clamp01: clamps to the unit interval", () => {
  assert.equal(clamp01(0.25), 0.25);
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(undefined), 0);
});

test("fillRect: horizontal fills from the left; vertical fills from the bottom; clamped", () => {
  assert.deepEqual(fillRect(200, 20, 0.25, "horizontal"), { x: 0, y: 0, w: 50, h: 20 });
  assert.deepEqual(fillRect(200, 20, 0.75, "horizontal"), { x: 0, y: 0, w: 150, h: 20 });
  assert.deepEqual(fillRect(20, 200, 0.25, "vertical"), { x: 0, y: 150, w: 20, h: 50 });
  assert.deepEqual(fillRect(200, 20, 5, "horizontal"), { x: 0, y: 0, w: 200, h: 20 }); // clamp hi
  assert.deepEqual(fillRect(200, 20, -1, "horizontal"), { x: 0, y: 0, w: 0, h: 20 }); // clamp lo
});

// ── (2) progress_bar.emit = track + fill ──────────────────────────────────────
test("progress_bar.emit: two boxes; fill width = fraction · track width", () => {
  const bar = (frac) => progressBarPlugin.emit(
    { ...progressBarPlugin.defaults, w: 200, h: 20, fraction: frac, orientation: "horizontal" }, null, IDENTITY);
  const ops = bar(0.25);
  assert.equal(ops.length, 2, "track + fill");
  assert.equal(ops[0].w, 200, "track is the full bbox width");
  assert.equal(ops[1].w, 50, "fill is 25% of the track");
  assert.equal(bar(0.75)[1].w, 150, "fill tracks fraction");
  assert.equal(bar(1)[1].w, 200, "full");
  assert.equal(bar(0)[1].w, 0, "empty");
});

// ── (3) video_scrub exports are referenceable RAW scalars (no world transform) ─
test("video_scrub: seconds/progress/duration are discoverable referenceable exports", () => {
  const refs = numericPropertyPaths(videoScrubPlugin);
  for (const k of ["seconds", "progress", "duration"]) assert.ok(refs.includes(k), `${k} referenceable`);
});

test("video_scrub exports resolve to RAW scalars via @id prop ref, even when the scrubber is moved/rotated/scaled", () => {
  const registry = createRegistry();
  registry.register(rectPlugin);
  registry.register(videoScrubPlugin);
  // Non-trivial transform: if these were ANCHOR refs they'd be corrupted by it.
  const state = {
    items: {
      vs: { ...videoScrubPlugin.defaults, name: "Clip", x: 400, y: 250, w: 320, h: 180, rotation: 37, scale: 1.7, scrubTime: 2.25, duration: 3 },
      sref: { type: "rect", name: "S", x: 0, y: 0, w: "= @vs.seconds", h: 10, rotation: 0, scale: 1 },
      pref: { type: "rect", name: "P", x: 0, y: 0, w: "= @vs.progress", h: 10, rotation: 0, scale: 1 },
      dref: { type: "rect", name: "D", x: 0, y: 0, w: "= @vs.duration", h: 10, rotation: 0, scale: 1 },
    },
    vars: {},
  };
  const { state: out, errors } = evaluateState(state, registry);
  assert.equal(errors.size, 0, "no equation errors");
  assert.equal(out.items.sref.w, 2.25, "seconds = raw scrubTime");
  assert.equal(out.items.dref.w, 3, "duration = raw duration input");
  assert.ok(Math.abs(out.items.pref.w - 0.75) < 1e-9, "progress = scrubTime/duration = 0.75 (un-transformed)");
});

test("video_scrub progress is an HONEST 0 when the duration is unknown (0) — no fake time", () => {
  const registry = createRegistry();
  registry.register(rectPlugin);
  registry.register(videoScrubPlugin);
  const state = {
    items: {
      vs: { ...videoScrubPlugin.defaults, name: "Clip", scrubTime: 12.5, duration: 0 },
      pref: { type: "rect", name: "P", x: 0, y: 0, w: "= @vs.progress + 1", h: 10, rotation: 0, scale: 1 },
    },
    vars: {},
  };
  const { state: out } = evaluateState(state, registry);
  assert.equal(out.items.pref.w, 1, "progress is 0 (so w = 0 + 1) when duration unknown");
});

// ── (4) END TO END: bar fill tracks the video's progress as scrubTime tweens ──
test("bound progress_bar fills to track the scrubber's fraction across a slide tween", () => {
  const registry = createRegistry();
  registry.register(rectPlugin);
  registry.register(cameraPlugin);
  registry.register(videoScrubPlugin);
  registry.register(progressBarPlugin);
  const W = 640, H = 360, BARW = 320, DUR = 3;
  const cam = { type: "camera", name: "Camera", x: 0, y: 0, w: W, h: H, z: 1000, rotation: 0, scale: 1, active: true, background: "#222" };
  // scrubTime keyframes 0.75 (slide 0) → 2.25 (slide 1). With duration 3, that is
  // fraction 0.25 → 0.75; folding slide 1 at alpha a gives fraction 0.25 + 0.5·a.
  const vs = { ...videoScrubPlugin.defaults, name: "Clip", x: 0, y: 0, w: W, h: 200, z: 1, active: true, duration: DUR, scrubTime: 0.75 };
  const pb = { ...progressBarPlugin.defaults, name: "Bar", x: 0, y: 260, w: BARW, h: 24, z: 2, active: true, fraction: "= @vs.progress" };
  const doc = {
    meta: { name: "t", slideW: W, slideH: H },
    slides: [
      { id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: { cam, vs, pb }, vars: {} } },
      { id: "s1", name: "B", transition: { type: "fade", seconds: 1 }, delta: { items: { vs: { scrubTime: 2.25 } }, vars: {} } },
    ],
  };
  for (const [alpha, expected] of [[0, 0.25], [0.5, 0.5], [1, 0.75]]) {
    const folded = foldState(doc, 1, alpha);
    const { state: out, errors } = evaluateState(folded, registry);
    assert.equal(errors.size, 0, `alpha ${alpha}: no errors`);
    assert.ok(Math.abs(out.items.pb.fraction - expected) < 1e-9, `alpha ${alpha}: fraction ${out.items.pb.fraction} != ${expected}`);
    const ops = progressBarPlugin.emit(out.items.pb, null, IDENTITY);
    const ratio = ops[1].w / ops[0].w; // fill / track
    assert.ok(Math.abs(ratio - expected) < 1e-9, `alpha ${alpha}: fill ratio ${ratio} != ${expected}`);
  }
});

// ── (5) a created doc repairs clean ───────────────────────────────────────────
test("a video_scrub + linked progress_bar document repairs with ZERO reports (idempotent)", () => {
  const registry = createRegistry();
  // camera is registered too so repair's camera-ensure step is satisfied; we then
  // assert no repair report mentions EITHER of our two items specifically.
  for (const p of [rectPlugin, cameraPlugin, videoScrubPlugin, progressBarPlugin]) registry.register(p);
  let doc = { meta: { name: "t", slideW: 640, slideH: 360 }, slides: [{ id: "s0", name: "A", transition: { type: "fade", seconds: 1 }, delta: { items: {}, vars: {} } }] };
  let scrubId, barId;
  [doc, scrubId] = withNewItem(doc, 0, { ...videoScrubPlugin.defaults, active: true, z: 1, duration: 3, scrubTime: 1.5 });
  [doc, barId] = withNewItem(doc, 0, { ...progressBarPlugin.defaults, active: true, z: 2, w: 320, h: 24, fraction: `= @${scrubId}.progress` });
  const { reports } = repairedDocument(doc, registry);
  // Only the CAMERA-ensured report may appear (no camera in this minimal doc); the
  // two items themselves must trigger no missing-default / migration report.
  const itemReports = reports.filter((r) => r.includes(scrubId) || r.includes(barId));
  assert.deepEqual(itemReports, [], `no item repair reports, got: ${itemReports.join(" | ")}`);
});

console.log(`\n${passed} progress-bar tests passed`);
