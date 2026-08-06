/**
 * THE AUDIO MIRROR'S DECISIONS — pure, DOM-free, engine-free.
 *
 * ── THE SPLIT, AND WHY IT IS THE SAME SPLIT AS core/wire_drag.js ────────────
 * web/audioMirror.svelte.js owns the AudioContext, the one engine instance, the
 * subscription lifetimes and the promises. THIS file owns every DECISION it makes:
 * which items are modules, which wires are real, and — the part that matters —
 * exactly which engine calls turn scene A into scene B.
 *
 * The reason for the split is that the decisions are where a mistake is SILENT. A
 * missing `disconnect` leaves a wire in the engine that is not on the canvas; a
 * missed `setParam` leaves a knob that visibly moved and audibly did not; a
 * `connect` emitted before its `addModule` throws in the middle of a presentation.
 * None of those are visible in a screenshot and none produce an exception you can
 * trace back. Expressed as a pure function from two scenes to a list of calls, all
 * of them are ordinary assertions in bare node — which is what
 * tests/audio_nodes_test.js does with them.
 *
 * ── WHY A DIFF AND NOT "REBUILD THE PATCH EVERY TIME" ───────────────────────
 * Rebuilding is far simpler and it is wrong, for a measured reason: every topology
 * change in the engine costs a guarded ramp-cut-ramp of about 40 ms during which
 * the affected path is quiet (synth/engine.js's own accounting). The evaluated
 * document state changes on every pointermove of every drag — moving a node's CARD
 * across the canvas re-evaluates the scene — so a rebuild-always mirror would tear
 * down and reconstruct the entire patch continuously and the sound would be a
 * permanent stutter. The diff makes a node DRAG produce ZERO engine calls, which is
 * the only way "it plays while you edit" can be true.
 *
 * ── THE ORDERING CONTRACT ───────────────────────────────────────────────────
 * The op list is ordered, and the order is not cosmetic:
 *   1. DISCONNECT wires that are going away, and every wire touching a module that
 *      is going away — before the module is removed, so the engine never has to
 *      reason about a wire to a corpse.
 *   2. REMOVE modules that are gone.
 *   3. ADD modules that are new (including REBUILDS of construct-time changes).
 *   4. CONNECT new wires — after every module they name exists.
 *   5. SET PARAMS that changed.
 * A `connect` naming a module that has not been added is an error in the engine, so
 * 3-before-4 is a hard requirement rather than a preference. Pinned by test.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 * It does not import synth/**, does not touch an AudioContext, and never awaits
 * anything. The engine's promise semantics (add/remove/connect/disconnect resolve
 * when the wire actually switches, ~33 ms) belong to the mirror, because "when did
 * it settle" is not a decision — it is a lifetime.
 */

import { audioKnobValues } from "./audio_nodes.js";

/**
 * Query (reads the plugin registry). THE AUDIO SCENE of a folded item map: which
 * items are audio modules, what each one's knobs are set to, and which wires
 * between them are real.
 *
 * ── WHY THIS IS A SEPARATE STEP FROM THE DIFF ───────────────────────────────
 * Reading is where every "is this real?" question is answered, and there are more
 * of them than there look to be. A document is mostly rectangles and text; a wire
 * can name an item that was deleted, a port a retyped widget no longer declares, or
 * a NUMBER node that drives document state rather than an AudioParam. Every one of
 * those must be dropped HERE, quietly, because they are ordinary consequences of
 * editing rather than errors — and because the alternative is handing the engine an
 * id it has never heard of and getting a throw in the middle of a presentation.
 *
 * The one thing that is NOT dropped quietly is a spec/engine mismatch, which cannot
 * arise at runtime: tests/audio_nodes_test.js proves every declared port and knob
 * exists before any of this runs.
 *
 * @param {object} items - the folded (and evaluated) item map
 * @param {object} registry - the plugin registry
 * @returns {{modules: object, connections: object[]}}
 *
 * @example // readAudioScene({o: {type: "audio_output"}}, registry).modules.o.module // "output"
 * @example readAudioScene({}, {get: () => ({})}).connections // []
 */
export function readAudioScene(items, registry) {
  const modules = {};
  for (const [id, state] of Object.entries(items ?? {})) {
    // `active: false` is the universal "exists on some slides and not others" leaf
    // (Delete keyframes it). A module that kept playing after its widget vanished
    // from the slide would be a sound with no visible source — the un-debuggable case.
    if (state?.active === false) continue;
    const plugin = pluginFor(registry, state?.type);
    if (!plugin?.audioModule) continue;
    modules[id] = {
      module: plugin.audioModule,
      type: state.type,
      spec: plugin.audioSpec,
      knobs: Object.fromEntries(audioKnobValues(plugin.audioSpec, state).map((k) => [k.key, k.value])),
    };
  }

  const connections = [];
  for (const [targetId, target] of Object.entries(modules)) {
    const wires = items[targetId]?.inputs ?? {};
    for (const [targetPort, wire] of Object.entries(wires)) {
      if (!wire || typeof wire !== "object" || typeof wire.item !== "string") continue;
      const source = modules[wire.item];
      // Not an audio module (a number node, a deleted item, a rect): NOT A WIRE the
      // engine can make. The canvas still draws it — a number node CAN legitimately
      // be wired to a node widget — it simply has no engine counterpart.
      if (!source) continue;
      const inPort = (target.spec.inputs ?? []).find((p) => p.key === targetPort);
      const outPort = (source.spec.outputs ?? []).find((p) => p.key === wire.port);
      if (!inPort || !outPort) continue;
      // A METHOD port (the ding's gate) is not an AudioNode input — striking a bell
      // calls engine.trigger(). It is carried through as a wire the mirror routes
      // differently rather than as one the engine connects.
      connections.push({ sourceId: wire.item, sourcePort: wire.port, targetId, targetPort, method: !!inPort.method });
    }
  }
  return { modules, connections };
}

/** Query. A plugin by type, or null — `registry.get` THROWS on an unknown type
 *  (NF-CORE hit exactly this: an unknown type killed a whole render), and a
 *  document mid-edit legitimately holds types this registry may not have. */
function pluginFor(registry, type) {
  if (!type || !registry) return null;
  try { return registry.get(type); } catch { return null; }
}

/** A connection's identity, for set differencing. */
const wireKey = (c) => `${c.sourceId}:${c.sourcePort}->${c.targetId}:${c.targetPort}`;

/**
 * Pure function. The construct-time params a module must be BUILT with.
 *
 * These are the knobs the engine has no setter for (see core/audio_specs.js's
 * `construct: true`). They are passed to addModule, which means a REBUILD carries
 * them — without this, a noise node rebuilt after a colour change would come back
 * at the engine's own default and the change the author just made would silently
 * revert.
 *
 * @param {object} spec - an audio node spec
 * @param {object} knobs - {key: value} as read by readAudioScene
 * @returns {object} the params object for addModule
 *
 * @example audioEngineOps.constructParams({knobs: [{key: "color", default: "pink", construct: true}]}, {color: "white"}) // {color: "white"}
 */
function constructParams(spec, knobs) {
  const out = {};
  for (const k of spec.knobs ?? []) if (knobs[k.key] !== undefined) out[k.key] = knobs[k.key];
  return out;
}

/** The ramp a live knob change is given, in seconds. Long enough that a scrubbed
 *  slider is a glide rather than a staircase of clicks; short enough that turning a
 *  knob still feels immediate. An AudioParam set with no ramp at all is a step
 *  discontinuity, which is audible as a tick on anything loud. */
export const KNOB_RAMP_SECONDS = 0.02;

/**
 * Pure function. THE DIFF: the ordered engine calls that turn scene `prev` into
 * scene `next`.
 *
 * Each op is a plain record naming an engine method and its arguments, so this
 * function is a TRANSCRIPT rather than a caller — which is what lets a test assert
 * the calls without an AudioContext, and what lets the mirror await their promises.
 *
 * @param {object} prev - a readAudioScene result (the engine's current state)
 * @param {object} next - a readAudioScene result (what the document now says)
 * @returns {object[]} ordered ops: {op, ...args}
 *
 * @example diffAudioScene({modules: {}, connections: []}, {modules: {}, connections: []}) // []
 * @example // adding one module is one call
 * @example diffAudioScene({modules: {}, connections: []}, {modules: {a: {module: "noise", type: "audio_noise", spec: {knobs: []}, knobs: {}}}, connections: []}).length // 1
 */
export function diffAudioScene(prev, next) {
  const ops = [];
  const prevModules = prev.modules ?? {};
  const nextModules = next.modules ?? {};

  // A module REBUILDS when its engine type changed (a retype) or when any
  // construct-time knob changed. Treated exactly like a remove+add, because that is
  // what it is — which also means its wires are cut and re-made, and the ordering
  // rules below cover it with no special case.
  const rebuilt = new Set();
  for (const id of Object.keys(nextModules)) {
    const before = prevModules[id], after = nextModules[id];
    if (!before) continue;
    if (before.module !== after.module) { rebuilt.add(id); continue; }
    for (const k of (after.spec.knobs ?? []).filter((x) => x.construct))
      if (before.knobs[k.key] !== after.knobs[k.key]) { rebuilt.add(id); break; }
  }

  const gone = (id) => (!(id in nextModules)) || rebuilt.has(id);
  const born = (id) => (!(id in prevModules)) || rebuilt.has(id);

  // ── 1. DISCONNECT ─────────────────────────────────────────────────────────
  // Wires that are going away, PLUS every wire touching a module that is going
  // away — the engine must never be asked to reason about a wire to a corpse.
  const nextWires = new Set((next.connections ?? []).filter((c) => !c.method).map(wireKey));
  for (const c of (prev.connections ?? []).filter((x) => !x.method)) {
    if (nextWires.has(wireKey(c)) && !gone(c.sourceId) && !gone(c.targetId)) continue;
    ops.push({ op: "disconnect", sourceId: c.sourceId, sourcePort: c.sourcePort, targetId: c.targetId, targetPort: c.targetPort });
  }

  // ── 2. REMOVE ─────────────────────────────────────────────────────────────
  for (const id of Object.keys(prevModules)) if (gone(id)) ops.push({ op: "removeModule", id });

  // ── 3. ADD ────────────────────────────────────────────────────────────────
  for (const [id, m] of Object.entries(nextModules))
    if (born(id)) ops.push({ op: "addModule", id, module: m.module, type: m.type, params: constructParams(m.spec, m.knobs) });

  // ── 4. CONNECT ────────────────────────────────────────────────────────────
  // After every module exists. A wire survives untouched only if BOTH ends did.
  const prevWires = new Set((prev.connections ?? []).filter((c) => !c.method).map(wireKey));
  for (const c of (next.connections ?? []).filter((x) => !x.method)) {
    if (prevWires.has(wireKey(c)) && !born(c.sourceId) && !born(c.targetId)) continue;
    ops.push({ op: "connect", sourceId: c.sourceId, sourcePort: c.sourcePort, targetId: c.targetId, targetPort: c.targetPort });
  }

  // ── 5. SET PARAMS ─────────────────────────────────────────────────────────
  // Only for modules that SURVIVED: a module just added already carries its
  // construct params, and re-sending every knob on birth would be a burst of
  // redundant ramps. Live knobs on a NEW module are set by the mirror right after
  // the add, which it does through these same ops on the following pass.
  for (const [id, m] of Object.entries(nextModules)) {
    const before = prevModules[id];
    if (!before || rebuilt.has(id)) continue;
    for (const k of m.spec.knobs ?? []) {
      if (k.construct) continue; // handled by the rebuild above
      const value = m.knobs[k.key];
      if (before.knobs[k.key] === value) continue;
      // A DISCRETE param is a SETTER in the engine, not an AudioParam: rampSeconds
      // is meaningless for it and asking for one would put a lie in the transcript.
      ops.push({ op: "setParam", id, key: k.key, value, rampSeconds: k.discrete ? 0 : KNOB_RAMP_SECONDS });
    }
  }

  return ops;
}

/**
 * Pure function. The LIVE knobs of a freshly-added module, as setParam ops.
 *
 * Called by the mirror immediately after an `addModule`, because addModule carries
 * only the CONSTRUCT-time params: everything else must be pushed once so a module
 * born mid-session is at the values the document says rather than at the engine's
 * factory defaults. Separate from diffAudioScene so the birth burst is explicit and
 * so it can be sent with NO ramp (there is nothing to glide from — the module has
 * not made a sound yet, so a ramp would just delay the first one).
 *
 * @param {object} module - a readAudioScene module record
 * @param {string} id - its item id
 * @returns {object[]} setParam ops
 *
 * @example initialParamOps({module: "noise", spec: {knobs: [{key: "level", default: 0.5}]}, knobs: {level: 0.3}}, "n") // [{op: "setParam", id: "n", key: "level", value: 0.3, rampSeconds: 0}]
 */
export function initialParamOps(module, id) {
  return (module.spec.knobs ?? [])
    .filter((k) => !k.construct)
    .map((k) => ({ op: "setParam", id, key: k.key, value: module.knobs[k.key], rampSeconds: 0 }));
}

/** The op builders, exposed as one object so tests can reach the pieces the diff
 *  uses without re-deriving them. */
export const audioEngineOps = { constructParams, wireKey };

/** The scheduler's own parameter names (synth/scheduler.js `setTempo`,
 *  `setStepCount`), which are ALSO the knob keys the specs that own those numbers
 *  declare. Spelled here rather than as a list of module names on purpose: a list
 *  of names would be a second copy of core/audio_specs.js's shape and would go
 *  stale the day a new tempo source is added. Whatever module declares the knob
 *  drives the transport. */
const TEMPO_KNOB = "bpm";
const STEP_COUNT_KNOB = "stepCount";

/**
 * Pure function. THE SHARED TRANSPORT a scene asks for — the step clock's tempo
 * and pattern length, read off whichever modules declare those knobs.
 *
 * ── WHY THIS IS DOCUMENT STATE AND NOT A SCHEDULER DEFAULT ──────────────────
 * The scheduler was running at its own factory 90 BPM / 16 steps and nothing ever
 * told it otherwise: the Clock node's Tempo knob set only its own oscillator's
 * frequency, so the knob the author turned and the transport the sequencer ran on
 * were two different numbers. That is the same class of defect as a knob that
 * visibly moves and audibly does not.
 *
 * THERE IS ONE TRANSPORT, so a patch with two Clocks is locked to the FIRST in
 * document order — stated rather than averaged, because averaging two tempos
 * produces a third that neither knob shows.
 *
 * A null means "no module on this slide declares it": the caller leaves the
 * scheduler's current setting alone rather than inventing one.
 *
 * @param {object} scene - a readAudioScene result
 * @returns {{bpm: number|null, stepCount: number|null}}
 *
 * @example transportOf({modules: {}}) // {bpm: null, stepCount: null}
 * @example transportOf({modules: {c: {spec: {knobs: [{key: "bpm"}]}, knobs: {bpm: 128}}}}) // {bpm: 128, stepCount: null}
 * @example transportOf({modules: {s: {spec: {knobs: [{key: "stepCount"}]}, knobs: {stepCount: 12}}}}) // {bpm: null, stepCount: 12}
 */
export function transportOf(scene) {
  const transport = { bpm: null, stepCount: null };
  for (const module of Object.values(scene?.modules ?? {})) {
    for (const knob of module.spec?.knobs ?? []) {
      const value = module.knobs?.[knob.key];
      if (!Number.isFinite(value)) continue;
      if (knob.key === TEMPO_KNOB && transport.bpm === null) transport.bpm = value;
      else if (knob.key === STEP_COUNT_KNOB && transport.stepCount === null) transport.stepCount = value;
    }
  }
  return transport;
}
