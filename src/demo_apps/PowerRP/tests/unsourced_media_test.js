/**
 * A FRESHLY INSERTED WIDGET MUST NOT HAND ANYTHING TO A VIDEO DECODER.
 *
 * The defect this pins (R6-12, measured wave 1 and again in wave 5): the video
 * player, the video scrubber and the demo time-scrubber all defaulted `src` to a
 * 1×1 transparent PNG data URI, copied from the image widget with the
 * justification "it decodes to one transparent frame, so the widget draws nothing
 * until a real video is picked". That is true of an `<img>` and FALSE of a
 * `<video>`, which refuses a PNG outright:
 *
 *   MediaError code 4: MEDIA_ELEMENT_ERROR: Unable to load URL due to content type
 *
 * So every unsourced video widget logged a load failure on the paint that created
 * its element. That was merely noise until a failed source started REFUSING the
 * frame (web/renderJobPage.js settledFrame, the fix for "the video does not appear
 * in Render Center output"), at which point "add a video widget, don't pick a
 * source yet, hit Render" would have failed every render in the deck. The two
 * changes are therefore one change, and this is the half of it a bare-node suite
 * can hold still.
 *
 * WHY THE LAW IS STATED OVER THE WHOLE REGISTRY rather than over a list of three
 * plugin names: a list of names is a hand-maintained mirror of the plugin pool and
 * rots the moment a fourth video widget is added — which is exactly how there came
 * to be seven of them. The subjects are DERIVED (every registered plugin whose
 * defaults carry a string `src`), so a new one joins the gate by existing.
 *
 * Run:  node src/demo_apps/PowerRP/tests/unsourced_media_test.js
 */
import assert from "node:assert/strict";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { identity } from "../core/transform.js";

/**
 * Every IR op whose ref is handed to an HTMLMediaElement decoder. A `data:image/…`
 * URI in any of these is a category error: the element rejects it and reports a
 * corrupt-file failure for a file that was simply never chosen.
 */
const DECODER_OPS = new Set(["video", "videoFrame", "videoV2", "videoV5", "videoV5Frame"]);

let checks = 0;
function ok(label, fn) {
  fn();
  checks++;
  console.log(`PASS  ${label}`);
}

const registry = createRegistry();
registerAll(registry, createCommands());

/**
 * Pure function. Every op kind `plugin.emit` produces for `state`, flattened
 * through the two container ops a decorated media widget wraps its quad in
 * (cropSubtree / effectSubtree), so a video quad inside an effects group is still
 * seen.
 *
 * @param {object[]} commands a display list
 * @returns {Set<string>} the op names present at any depth
 *
 * @example // opKinds([{op: "rect"}, {op: "effectSubtree", content: [{op: "video"}]}])
 * // Set {"rect", "effectSubtree", "video"}
 */
function opKinds(commands) {
  const kinds = new Set();
  const walk = (cmds) => {
    for (const c of cmds ?? []) {
      kinds.add(c.op);
      if (Array.isArray(c.content)) walk(c.content);
    }
  };
  walk(commands);
  return kinds;
}

/** Query. Every registered plugin whose defaults carry a string `src` — the
 * media-widget family, derived rather than listed. */
function srcDefaultingPlugins() {
  return registry.all().filter((p) => typeof p.defaults?.src === "string");
}

ok("the registry actually yields media widgets to test (a vacuous pass is not a pass)", () => {
  const subjects = srcDefaultingPlugins();
  assert.ok(subjects.length >= 8, `expected the media family to be found, got ${subjects.length}: ${subjects.map((p) => p.type).join(", ")}`);
});

ok("no freshly inserted widget emits a decoder op — the unsourced default reaches no <video>", () => {
  const offenders = [];
  for (const plugin of srcDefaultingPlugins()) {
    if (typeof plugin.emit !== "function") continue;
    const kinds = opKinds(plugin.emit(plugin.defaults, identity(), identity()));
    const reaching = [...kinds].filter((k) => DECODER_OPS.has(k));
    if (reaching.length) offenders.push(`${plugin.type} (src ${JSON.stringify(plugin.defaults.src.slice(0, 40))} → ${reaching.join(", ")})`);
  }
  assert.deepEqual(offenders, [], `these widgets hand their UNSOURCED default straight to a media decoder:\n  ${offenders.join("\n  ")}`);
});

ok("no VIDEO-asset widget defaults its src to an image data URI", () => {
  // The complementary direction, and it is not redundant: the check above passes
  // whenever a widget draws nothing for ANY reason, so a widget that kept the PNG
  // default and merely happened to be zero-sized would slip through. This one names
  // the VALUE.
  //
  // THE SUBJECT IS NARROWED TWICE, and both narrowings are load-bearing. First
  // declaratively, by the src row's `assetKinds` — that is what excludes the PDF
  // widgets, whose emit FETCHES, and a gate must not do network I/O to answer a
  // question the plugin already states. Then by emit, with a plausible video source
  // — that is what excludes video_v6 / video_v7, which are OVERLAY widgets: their
  // emit produces only a poster, they never hand the src to a decoder, and their
  // overlays read `data:image/…` as their own "not yet sourced" marker. That is a
  // second vocabulary for one idea and it should go when R6-12.3 collapses the
  // family, but it is not this defect, and a gate that reported it here would be
  // reporting something that cannot fail a render.
  const offenders = [];
  for (const plugin of srcDefaultingPlugins()) {
    const row = plugin.inspector?.find((r) => r?.key === "src");
    if (!row?.assetKinds?.includes("video")) continue; // not a video widget
    if (typeof plugin.emit !== "function") continue;
    const kinds = opKinds(plugin.emit({ ...plugin.defaults, src: "clip.mp4" }, identity(), identity()));
    if (![...kinds].some((k) => DECODER_OPS.has(k))) continue; // draws a poster, never decodes
    if (plugin.defaults.src.startsWith("data:image/")) offenders.push(plugin.type);
  }
  assert.deepEqual(offenders, [], `these VIDEO widgets default to an IMAGE data URI, which a <video> refuses (MediaError code 4): ${offenders.join(", ")}`);
});

console.log(`\nunsourced_media_test: ${checks} checks passed`);
