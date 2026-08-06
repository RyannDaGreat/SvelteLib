/**
 * THE AUDIO MUTE (R7-22) — session state, a master gain, and the one property
 * that makes an export safe.
 * Run: node src/demo_apps/PowerRP/tests/audio_mute_test.js
 *
 * ── WHAT IS WORTH PINNING HERE, AND WHAT IS NOT ─────────────────────────────
 * "Does a gain of 0 make silence" is Web Audio's job, not ours, and cannot be
 * checked in bare node anyway. What CAN go silently wrong is the wiring, and the
 * failure it produces is the one this project forbids outright: **a video exported
 * while the author happened to be muted, coming out silent, with a green exit
 * code.** So the assertions are about STRUCTURE:
 *
 *   §1 the mute is downstream of the capture tap, so a recorder cannot capture it
 *   §2 an output module lands on the master bus, and REFUSES to be built without
 *      one — an output wired straight to the destination would be audible while
 *      muted and invisible to a recorder, wrong in both directions at once
 *   §3 the mute is a GAIN, not a suspend, so the transport clock keeps running
 *   §4 it is session state: it touches no document, no delta, no share link
 *   §5 it is surfaced once and reachable three ways
 *
 * A FAKE AUDIOCONTEXT, because `createEngine` takes one (`options.audioContext`)
 * and node has none. It records the graph rather than simulating DSP, which is
 * exactly the layer the claims above live at.
 */

import assert from "node:assert/strict";

import { createEngine } from "../synth/engine.js";
import { MODULE_FACTORIES } from "../synth/modules.js";
import { KEYBINDING_DEFAULTS, KEYBINDING_LABELS, WHEN_RESOLVERS } from "../core/shortcut_entries.js";

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// ── THE FAKE CONTEXT ─────────────────────────────────────────────────────────

/** Command. A minimal AudioContext that records connections. Every node gets an
 *  identity so a test can assert the SHAPE of the graph. */
function fakeContext() {
  let nextId = 0;
  const edges = [];
  const make = (kind, extra = {}) => {
    const node = {
      kind, id: `${kind}${nextId++}`, ...extra,
      connect(target) { edges.push([node.id, target?.id ?? "destination"]); },
      disconnect() {},
    };
    return node;
  };
  const param = (value) => ({ value, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} });
  const ctx = {
    state: "running", currentTime: 0, sampleRate: 48000, edges,
    destination: { id: "destination" },
    createGain: () => make("gain", { gain: param(1) }),
    createDynamicsCompressor: () => make("comp", {
      threshold: param(0), knee: param(0), ratio: param(1), attack: param(0), release: param(0),
    }),
    createConstantSource: () => make("const", { offset: param(0), start() {}, stop() {} }),
    createBuffer: (ch, len, rate) => ({ length: len, sampleRate: rate, numberOfChannels: ch, getChannelData: () => new Float32Array(len) }),
    async suspend() { ctx.state = "suspended"; },
    async resume() { ctx.state = "running"; },
    async close() { ctx.state = "closed"; },
  };
  return ctx;
}

/** Query. The engine's master chain as a list of edges among gain nodes and the
 *  destination — everything created before any module exists. */
function masterChain(ctx) {
  return ctx.edges.map(([from, to]) => `${from}->${to}`);
}

console.log("\n§1 THE MUTE IS DOWNSTREAM OF THE CAPTURE TAP");

test("the master chain is bus -> mute -> destination, in that order", () => {
  const ctx = fakeContext();
  const engine = createEngine({ audioContext: ctx });
  const chain = masterChain(ctx);
  assert.equal(chain.length, 2, `exactly two master edges, got ${JSON.stringify(chain)}`);
  const tap = engine.captureTap();
  const [busEdge, muteEdge] = chain;
  assert.equal(busEdge.split("->")[0], tap.id, "the capture tap is the FIRST node, so a recorder taking it sits above the mute");
  assert.equal(busEdge.split("->")[1], muteEdge.split("->")[0], "the tap feeds the mute");
  assert.equal(muteEdge.split("->")[1], "destination", "and the mute is the last thing before the speakers");
});

test("muting moves the MUTE gain and leaves the capture tap at unity", () => {
  const ctx = fakeContext();
  const engine = createEngine({ audioContext: ctx });
  const tap = engine.captureTap();
  assert.equal(engine.isMuted(), false);
  engine.setMuted(true);
  assert.equal(engine.isMuted(), true, "the engine reports the node's own value, not a remembered flag");
  assert.equal(tap.gain.value, 1,
    "THE EXPORT GUARANTEE: the tap a recorder connects to is untouched by the mute, so a video rendered while muted is not silent");
  engine.setMuted(false);
  assert.equal(engine.isMuted(), false);
  assert.equal(tap.gain.value, 1);
});

console.log("\n§2 EVERY OUTPUT LANDS ON THE BUS, AND CANNOT NOT");

test("an output module connects its limiter to the master bus, never to the destination", () => {
  const ctx = fakeContext();
  const engine = createEngine({ audioContext: ctx });
  const tap = engine.captureTap();
  const before = ctx.edges.length;
  engine.addModule("output", "out1", {});
  const added = ctx.edges.slice(before).map(([from, to]) => to);
  assert.ok(added.includes(tap.id), `the output reaches the bus (${JSON.stringify(added)})`);
  assert.ok(!added.includes("destination"),
    "and NOT the destination — an output that bypassed the bus would stay audible while muted and be invisible to a recorder");
});

test("building an output with no master bus THROWS instead of silently bypassing", () => {
  const ctx = fakeContext();
  assert.throws(
    () => MODULE_FACTORIES.output(ctx, {}, { impulseResponse: () => null, strikeNoise: () => null }),
    /master bus.*required|required.*master bus/i,
  );
});

console.log("\n§3 A GAIN, NOT A SUSPEND — the transport clock keeps running");

test("muting does not suspend the context", () => {
  const ctx = fakeContext();
  const engine = createEngine({ audioContext: ctx });
  engine.setMuted(true);
  assert.equal(ctx.state, "running",
    "suspending would stop the AudioContext clock, which the shared transport schedules against");
  assert.equal(engine.isRunning(), true);
});

test("`disableAudio` is GONE — the self-defeating suspend must not come back", async () => {
  const mirror = await import("../web/audioMirror.svelte.js").catch(() => null);
  // The module imports Svelte runes and may not load in bare node; when it does
  // not, fall back to reading the source, which is what the claim is about.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../web/audioMirror.svelte.js"), "utf8");
  assert.ok(!/export async function disableAudio/.test(src),
    "disableAudio suspended the context, had zero callers, and was undone by the very next user gesture (R7-3's harvest)");
  assert.ok(/export function setAudioMuted/.test(src), "and setAudioMuted replaces it");
  if (mirror) assert.equal(typeof mirror.disableAudio, "undefined");
});

console.log("\n§4 SESSION STATE — the mute is in no document and no share link");

test("nothing in the document model knows about muting", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["../core/document.js", "../core/audio_specs.js"]) {
    const src = readFileSync(join(here, file), "utf8");
    assert.ok(!/\bmuted?\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
      `${file} must not carry a mute — sharing a deck must not share the author's mute`);
  }
});

console.log("\n§5 ONE ENTRY, THREE SURFACINGS");

test("the shortcut is registered, resolvable, and labelled for the HintBar", () => {
  const entry = KEYBINDING_DEFAULTS.find((b) => b.command === "toggle-audio-mute");
  assert.ok(entry, "a shortcut absent from KEYBINDING_DEFAULTS does not exist and never reaches the HintBar");
  assert.deepEqual(entry.keys, ["M"]);
  assert.ok(WHEN_RESOLVERS[entry.when], `its \`when\` (${entry.when}) names a real resolver`);
  assert.ok(KEYBINDING_LABELS["toggle-audio-mute"], "toShortcutEntries throws on a missing label");
});

test("plain M is claimed by nothing else", () => {
  const clashes = KEYBINDING_DEFAULTS.filter((b) => b.keys.length === 1 && b.keys[0] === "M");
  assert.equal(clashes.length, 1, `exactly one binding owns plain M, got ${clashes.length}`);
});

test("the command entry is well-formed and states its session-only scope", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../web/audioMirror.svelte.js"), "utf8");
  assert.ok(/export const AUDIO_MUTE_COMMAND/.test(src), "the entry is exported for web/App.svelte's coreCommands");
  assert.ok(/id: "toggle-audio-mute"/.test(src), "and its id is the one the shortcut and the toolbar name");
  // The help text is the only place a user learns that muting is not part of the
  // deck. R7-22 makes that distinction load-bearing, so it is pinned.
  assert.ok(/SESSION|session/.test(src) && /export|sharing|shared/i.test(src),
    "its help must say the mute is session-only and does not travel with the project");
});

console.log(failures === 0 ? "\nAll audio-mute tests passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
