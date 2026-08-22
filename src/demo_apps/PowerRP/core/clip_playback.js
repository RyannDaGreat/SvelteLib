/**
 * WHEN DOES A CLIP PLAY — the trigger, the playhead, and which of CLAUDE.md's four
 * kinds of state each answer lands in.
 *
 * ── THE ASK (user, 2026-08-08, verbatim) ────────────────────────────────────
 * "one thing to decide: WHEN does the signal editor start to play its song? what
 * triggers it? a button node?" … "the signal editor therefore needs an input node
 * too"
 *
 * So the clip node has a `trigger` INPUT. That part is easy. THE PLAYHEAD IS THE
 * HARD PART, and this file exists because the same port can produce two completely
 * different kinds of state depending on what is plugged into it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ── THE THREE PLAYBACK KINDS, AND WHAT EACH ONE COSTS ──────────────────────
 * ═══════════════════════════════════════════════════════════════════════════
 * "Where in the song am I" is always `now − startTime`. Everything turns on where
 * `startTime` comes from.
 *
 * ── "timeline" — NOTHING WIRED. **THE DEFAULT, AND IT IS RECORDABLE.** ──────
 * The clip starts at its own `startTime` property: an ordinary numeric leaf, folded
 * from `[[slide, alpha]]`, keyframable per slide. So the playhead is
 * `beatAtTime(t − startTime, tempo)` — A PURE FUNCTION OF `t` AND DOCUMENT STATE.
 * That is RECORDABLE state by CLAUDE.md's own defining test: Δt = 0 leaves it
 * unchanged, frame 200 renders without frame 199, and a render job may shard it by
 * strided frame range. It exports correctly, on every machine, every time.
 *
 * THIS IS THE DEFAULT ON PURPOSE. An author who wires nothing into the trigger gets
 * the reproducible behaviour, so the off-the-shelf experience exports correctly and
 * the non-reproducible one has to be asked for.
 *
 * ── "recordable" — A CLOCK (or any time-driven source). ALSO RECORDABLE. ───
 * A Clock's pulses are a pure function of its tempo and the elapsed time — there is
 * no history in "which pulse most recently fired at time t", which is exactly what
 * `lastPulseSeconds` below computes WITHOUT reference to any earlier frame. So a
 * clip retriggered by a clock still has a playhead that is a function of `t` alone.
 * Seekable, shardable, exports correctly. This is the loop.
 *
 * ── "live" — A BUTTON (or a keyboard). **EPHEMERAL. IT EXPORTS SILENT.** ───
 * `plugins/node_button.js` is explicit that its press "is LIVE, and does not touch
 * the document", and the manifest's ruling is that "a recorded export plays no
 * presses and that is CORRECT". So a live press has NO representation in
 * `[[slide, alpha]]`, and `startTime` is therefore the moment a hand moved —
 * HISTORY, not a function of `t`.
 *
 * That is not SIMULATED state either, and the distinction matters: simulated state
 * (`@`) is a function of its own previous value, which a contiguous walk from frame
 * 0 can reproduce. A press cannot be reproduced by ANY walk, because the input that
 * produced it is not in the document. It is EPHEMERAL — the one kind this project
 * has none of.
 *
 * **SO A BUTTON-TRIGGERED CLIP PLAYS LIVE AND RENDERS SILENT.** That follows from
 * existing doctrine and is not a bug to fix; the Button is for playing, and playing
 * is what happens in front of an audience.
 *
 * ── WHY IT IS A WARNING AND NOT A REFUSAL ──────────────────────────────────
 * Considered, and decided against, for the reason `server.py` already decided it
 * for the video PLAYER: refusing the export would make a legitimate deck
 * unrenderable because of a widget the author may not even be triggering during the
 * render. The failure to prevent is the SILENT one — hearing music live, exporting,
 * and getting nothing with no explanation. So `liveTriggeredClipRefusal` names the
 * offending nodes, says why, and points at the two deterministic alternatives,
 * exactly as `playback_clock_warning` names the players and points at the scrubber.
 * A user who reads it and exports anyway has made an informed choice.
 *
 * ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
 * It computes no schedule and touches no engine. It is the pure math and the pure
 * classification; the SCHEDULER that turns a playhead into note-ons at the audio
 * layer is not built here (see the report accompanying this work).
 *
 * DOM-free, engine-free, clock-free: `now` is always an argument.
 */

import { beatAtTime, soundingNotes } from "./midi_clip.js";
import { inputRefs, inputWires } from "./nodeflow.js";

/** The three playback kinds. `timeline` and `recordable` are both reproducible;
 *  only `live` is not — `PLAYBACK_REPRODUCIBLE` is the one predicate every reader
 *  should ask rather than comparing against the strings.
 *  @example PLAYBACK_KINDS.includes("live") // true
 *  @example PLAYBACK_REPRODUCIBLE.timeline // true
 *  @example PLAYBACK_REPRODUCIBLE.live // false */
export const PLAYBACK_REPRODUCIBLE = Object.freeze({ timeline: true, recordable: true, live: false });
export const PLAYBACK_KINDS = Object.freeze(Object.keys(PLAYBACK_REPRODUCIBLE));

/** THE INPUT PORT KEY a clip's trigger arrives on. Spelled once so the plugin, the
 *  classifier and the warning cannot disagree.
 *  @example TRIGGER_PORT // "trigger" */
export const TRIGGER_PORT = "trigger";

/**
 * Pure function. IS THIS SOURCE PLUGIN'S OUTPUT A LIVE HUMAN EVENT?
 *
 * ── ASKED OF THE DECLARATION, NEVER OF A TYPE LIST ─────────────────────────
 * `livePress` (the Button) and `livePlay` (the Keyboard) are the declarations that
 * ALREADY make a widget live — they are what `core/live_control.js` routes through,
 * and a widget that has one is by definition producing moments rather than values.
 * So this cannot drift: a NEW live control is classified correctly the day it is
 * written, with no roster to remember to update, and a widget that stopped being
 * live would stop being classified as such by the same edit.
 *
 * The alternative — a list of type names here — is the canvas if-chain that
 * `web/widget_handlers.js` exists to have abolished.
 *
 * @param {object} plugin - the SOURCE widget's plugin
 * @returns {boolean}
 *
 * @example isLiveSource({livePress: {port: "out"}}) // true
 * @example isLiveSource({livePlay: {port: "gate"}}) // true
 * @example // a clock is a module: time-driven, therefore reproducible
 * @example isLiveSource({audioModule: "clock"}) // false
 * @example isLiveSource({}) // false
 * @example isLiveSource(null) // false
 */
export function isLiveSource(plugin) {
  return !!(plugin?.livePress || plugin?.livePlay);
}

/**
 * Pure function. IS THIS PLUGIN A TRIGGERABLE MIDI SOURCE — something that emits a
 * `midi` stream AND has a trigger input deciding when it starts?
 *
 * ── THIS PREDICATE REPLACED "a widget declaring `midiClip`", AND THE USER FOUND
 *    THE HOLE ─────────────────────────────────────────────────────────────────
 * USER, 2026-08-08: "how to trigger the abc notation to start playing?" — asked
 * because the CLIP node had a trigger input and the ABC node did not. Both were
 * fixed to have one, and this predicate is the consequence: the determinism
 * classification used to key on `midiClip`, which only the clip node declares, so
 * an ABC node driven by a Button would have rendered SILENT **with no warning** —
 * the exact failure the warning exists to prevent, reintroduced by asking the wrong
 * question about which widgets are covered.
 *
 * ASKED OF THE PORTS, which is the thing that actually makes a widget triggerable.
 * A future arpeggiator or transposer that takes a trigger and emits `midi` is
 * covered the day it is written, with no roster to remember.
 *
 * @param {object} plugin - a widget plugin
 * @returns {boolean}
 *
 * @example isTriggerableMidiSource({ports: () => ({inputs: [{key: "trigger", type: "trigger"}], outputs: [{key: "midi", type: "midi"}]})}) // true
 * @example // a midi source with NO trigger input has no "when" to get wrong
 * @example isTriggerableMidiSource({ports: () => ({inputs: [], outputs: [{key: "midi", type: "midi"}]})}) // false
 * @example // …and a trigger input on something that is not a midi source is not this
 * @example isTriggerableMidiSource({ports: () => ({inputs: [{key: "trigger", type: "trigger"}], outputs: [{key: "out", type: "number"}]})}) // false
 * @example isTriggerableMidiSource({}) // false
 * @example isTriggerableMidiSource(null) // false
 */
export function isTriggerableMidiSource(plugin) {
  if (typeof plugin?.ports !== "function") return false;
  let ports = null;
  // A plugin's `ports` may legitimately read its state; `defaults` is the state
  // every plugin has. A throw here is a plugin bug and must not take out a sweep.
  try { ports = plugin.ports(plugin.defaults ?? {}); } catch { return false; }
  const emitsMidi = (ports?.outputs ?? []).some((p) => p.type === "midi");
  const takesTrigger = (ports?.inputs ?? []).some((p) => p.key === TRIGGER_PORT);
  return emitsMidi && takesTrigger;
}

/**
 * Query (reads the plugin registry). WHICH PLAYBACK KIND one clip node has.
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @param {string} itemId - the clip node
 * @returns {"timeline"|"recordable"|"live"}
 *
 * @example // NOTHING WIRED is the default, and it is the reproducible one
 * @example clipPlaybackKind({c: {type: "node_midi_clip"}}, {get: () => ({})}, "c") // "timeline"
 * @example clipPlaybackKind({c: {type: "node_midi_clip", inputs: {}}}, {get: () => ({})}, "c") // "timeline"
 * @example // a source that declares itself LIVE makes the playhead ephemeral
 * @example clipPlaybackKind({c: {type: "node_midi_clip", inputs: {trigger: {item: "b", port: "out"}}}, b: {type: "node_button"}}, {get: () => ({livePress: {}})}, "c") // "live"
 * @example // a DANGLING wire is not a live one — nothing ever pulses, so it is the default
 * @example clipPlaybackKind({c: {type: "node_midi_clip", inputs: {trigger: {item: "gone", port: "out"}}}}, {get: () => ({})}, "c") // "timeline"
 * @example // …and any other source keeps it a function of elapsed time
 * @example clipPlaybackKind({c: {type: "node_midi_clip", inputs: {trigger: {item: "k", port: "out"}}}, k: {type: "audio_clock"}}, {get: () => ({audioModule: "clock"})}, "c") // "recordable"
 */
export function clipPlaybackKind(items, registry, itemId) {
  // The trigger port is not `multiple`, so its slot holds one wire; inputRefs is
  // still the reader because it is the ONE reader of the slot's shape.
  const wire = inputRefs(items?.[itemId], TRIGGER_PORT)[0];
  if (!wire) return "timeline";
  const source = items?.[wire.item];
  // A DANGLING wire is not a live one. The node reads its type's zero (no pulse
  // ever arrives), so it behaves as an untriggered clip — and saying "live" here
  // would attach a determinism warning to a deck that has no live control in it.
  if (!source) return "timeline";
  let plugin = null;
  try { plugin = registry.get(source.type); } catch { return "timeline"; }
  return isLiveSource(plugin) ? "live" : "recordable";
}

/**
 * Pure function. THE PLAYHEAD, in beats, at presentation time `now`.
 *
 * NEGATIVE BEFORE THE CLIP STARTS, and that is deliberate rather than clamped: a
 * receiver asks `soundingNotes(notes, playhead)` and a negative beat correctly
 * sounds nothing. Clamping to 0 would make every clip hold its first chord from
 * the beginning of the presentation until its own start time.
 *
 * @param {number} now - presentation time, seconds
 * @param {number} startSeconds - when this playing of the clip began, seconds
 * @param {number} tempo - beats per minute
 * @returns {number} beats since the clip started
 *
 * @example playheadBeats(1, 0, 120) // 2
 * @example playheadBeats(0, 0, 120) // 0
 * @example // before its start time, the clip has not begun
 * @example playheadBeats(1, 3, 120) // -4
 */
export function playheadBeats(now, startSeconds, tempo) {
  return beatAtTime(now - startSeconds, tempo);
}

/**
 * Pure function. WHEN THE MOST RECENT CLOCK PULSE FIRED at or before `now`.
 *
 * ── THIS FUNCTION IS THE WHOLE ARGUMENT THAT A CLOCKED CLIP IS RECORDABLE ──
 * It answers "which pulse am I in" from `now` and the clock's own rate ALONE. No
 * previous frame, no accumulated counter, no state carried from frame N−1 — which
 * is precisely the test CLAUDE.md sets for recordable state, and precisely what
 * `core/document.stridedShardRefusal` exists to catch the absence of. A strided
 * shard can compute this for frame 200 without ever having rendered frame 199.
 *
 * A non-positive or unresolved rate means the clock never pulses, so the answer is
 * 0 (the clip runs from the timeline's origin) rather than a division by zero.
 *
 * @param {number} now - presentation time, seconds
 * @param {number} pulsesPerMinute - the clock's rate
 * @returns {number} seconds
 *
 * @example lastPulseSeconds(0.7, 120) // 0.5
 * @example lastPulseSeconds(1.2, 120) // 1
 * @example lastPulseSeconds(0.4, 60) // 0
 * @example // a stopped clock never pulses; the clip runs from the origin
 * @example lastPulseSeconds(9, 0) // 0
 */
export function lastPulseSeconds(now, pulsesPerMinute) {
  const rate = Number(pulsesPerMinute);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const period = 60 / rate;
  return Math.floor(Math.max(0, now) / period) * period;
}

/**
 * Query (reads the plugin registry). WHICH ENGINE MODULES receive this source's
 * `midi` stream — the routing a scheduler needs to know who to play.
 *
 * ── A MIDI WIRE IS NOT AN AUDIO WIRE, AND THIS IS WHERE THAT SHOWS ─────────
 * `readAudioScene` connects AudioNodes, and it only wires nodes that HAVE an
 * `audioModule` — so a cable out of a clip node is DROPPED there, exactly as a
 * cable out of a Keyboard is (tests/renderPatchAudio.mjs's `.UNPLAYED` tag records
 * the same fact). That is CORRECT rather than a gap: a midi cable does not carry a
 * signal to be connected, it carries the document-level fact "these notes go to
 * that instrument". So the routing is resolved HERE, from the document, and the
 * scheduler calls `engine.noteOn(id, …)` on the named module directly.
 *
 * MATCHED BY PORT TYPE, not by port key. Surge spells its midi input `notes`; a
 * future sampler may spell it `in`. What makes an input a midi receiver is its
 * declared TYPE, which is the same thing `typesCompatible` refused the bad drops on.
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @param {string} sourceId - the midi source's item id
 * @returns {Array<{id: string, port: string}>} the receiving modules
 *
 * @example midiRoutes({}, {get: () => null}, "c") // []
 * @example // a clip wired to nothing plays nothing
 * @example midiRoutes({c: {type: "node_midi_clip"}}, {get: () => ({})}, "c") // []
 */
export function midiRoutes(items, registry, sourceId) {
  const routes = [];
  for (const [targetId, target] of Object.entries(items ?? {})) {
    if (target?.active === false) continue;
    let plugin = null;
    try { plugin = registry.get(target?.type); } catch { continue; }
    // ONLY AN ENGINE MODULE can sound a note. A clip wired into a Number node is
    // legal on the canvas and simply has nothing to play — the same judgement
    // core/live_control.triggerRoutes makes, for the same reason.
    if (!plugin?.audioModule) continue;
    const inputs = plugin.audioSpec?.inputs ?? [];
    for (const [portKey, wire] of inputWires(target)) {
      if (wire.item !== sourceId) continue;
      const port = inputs.find((p) => p.key === portKey);
      if (port?.type !== "midi") continue;
      routes.push({ id: targetId, port: portKey });
    }
  }
  return routes;
}

/**
 * Query (reads the plugin registry). WHICH MIDI SOURCES a press on `sourceId`
 * RESTARTS — the clip nodes whose `trigger` input is wired to that control.
 *
 * ── WHY THIS EXISTS INSTEAD OF WIDENING `triggerRoutes` ────────────────────
 * `core/live_control.triggerRoutes` opens with `if (!plugin?.audioModule) continue;`
 * and it was tempting to delete that line, because a Button wired to a clip
 * produces zero routes and the press appears to vanish. **DELETING IT WOULD BE
 * WRONG.** That function answers exactly one question — "which ENGINE CALLS does
 * this press produce" — and its gate is what keeps it from handing the engine an id
 * it has never heard of, which its own docblock notes "throws in the middle of a
 * presentation, the one place an exception is most expensive". For a clip node the
 * honest answer to THAT question really is none: a clip has no engine counterpart
 * to strike.
 *
 * The press does something else entirely — it moves a PLAYHEAD, which is a fact
 * about the document's own playback, not an engine method call. So it is a SECOND
 * question with its own function, and `triggerRoutes` keeps both its gate and its
 * meaning. (This is the same split `noteRoutes` already makes beside it: two
 * questions about one press, answered separately, rather than one function with a
 * mode flag.)
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @param {string} sourceId - the control that fired
 * @param {string} [sourcePort] - which of its outputs fired
 * @returns {string[]} the ids of the midi sources this press restarts
 *
 * @example clipTriggerTargets({}, {get: () => null}, "b") // []
 */
export function clipTriggerTargets(items, registry, sourceId, sourcePort = "out") {
  const targets = [];
  for (const [id, state] of Object.entries(items ?? {})) {
    if (state?.active === false) continue;
    let plugin = null;
    try { plugin = registry.get(state?.type); } catch { continue; }
    if (!isTriggerableMidiSource(plugin)) continue;
    const wire = inputRefs(state, TRIGGER_PORT)[0];
    if (wire?.item !== sourceId) continue;
    if ((wire.port ?? "out") !== sourcePort) continue;
    targets.push(id);
  }
  return targets;
}

/**
 * Query (reads the plugin registry). THE PLAYHEAD of one midi source at
 * presentation time `now`, in beats — or null when it is not playing at all.
 *
 * The three kinds, resolved (see the file header for what each costs):
 *   timeline    `now − startTime`.
 *   recordable  `now − lastPulse`, the clock's most recent pulse. **THE CLOCK'S
 *               RATE IS READ**, not assumed: a wire that changed nothing observable
 *               is the "decorative cable" defect `core/live_control.js` records at
 *               length (the user disconnected a pitch cable and "it was fine…this is
 *               a big red flag"). A clock at 120 BPM must retrigger twice as often
 *               as one at 60, or the cable is a lie.
 *   live        `now − whenItWasPressed`, from the caller's scratch map. NULL when
 *               it has never been pressed — a live clip is SILENT until a hand
 *               starts it, which is the whole point of arming it that way.
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @param {string} itemId - the midi source
 * @param {number} now - presentation time, seconds
 * @param {object} [liveStarts] - `{itemId: seconds}` for live-triggered sources
 * @param {number} [liveNow] - the LIVE clock's reading, for live-triggered sources
 *     only (defaults to `now`). See the two-clocks note below.
 * @returns {number|null} beats, or null when not playing
 *
 * ── TWO CLOCKS, AND THE KIND OF CLOCK MATCHES THE KIND OF STATE ────────────
 * `now` is the PRESENTATION clock (`particleTime()`), which the presenter drives
 * and **the editor deliberately FREEZES for determinism** — measured: it sits at a
 * constant while the editor runs, which is exactly what makes a still render
 * reproducible. That is right for the two REPRODUCIBLE kinds: a timeline clip and a
 * clock-driven one must advance with the presentation, not with wall time, or an
 * export would not match the room.
 *
 * It is WRONG for a LIVE-triggered clip, and the symptom was concrete: pressing a
 * Button in the editor started a playhead that could never advance, so the chord
 * sounded and never released — a drone. A live press is EPHEMERAL state already
 * (it is why `live_trigger_warning` exists), so its playhead may legitimately run
 * on a live clock without weakening any determinism claim: that path is already
 * excluded from every export. So the caller passes the AUDIO clock as `liveNow`,
 * and ONLY the live branch reads it.
 *
 * @example // an untriggered clip runs from its own startTime
 * @example clipPlayhead({c: {type: "x", startTime: 0, tempo: 120}}, {get: () => ({})}, "c", 1) // 2
 * @example clipPlayhead({c: {type: "x", startTime: 1, tempo: 120}}, {get: () => ({})}, "c", 1) // 0
 * @example // a LIVE clip nobody has pressed is not playing
 * @example clipPlayhead({c: {type: "x", inputs: {trigger: {item: "b", port: "out"}}}, b: {type: "btn"}}, {get: () => ({livePress: {}})}, "c", 5, {}) // null
 */
export function clipPlayhead(items, registry, itemId, now, liveStarts = {}, liveNow = now) {
  const state = items?.[itemId];
  if (!state) return null;
  const tempo = state.tempo;
  const kind = clipPlaybackKind(items, registry, itemId);
  if (kind === "live") {
    const started = liveStarts?.[itemId];
    if (!Number.isFinite(started)) return null;
    // THE LIVE CLOCK, not the presentation one — see the two-clocks note above.
    return playheadBeats(liveNow, started, tempo);
  }
  if (kind === "recordable") {
    const wire = inputRefs(state, TRIGGER_PORT)[0];
    // The clock's OWN rate, off its own knob leaf. A source that is not a clock (no
    // bpm knob) falls back to the timeline reading rather than pretending to pulse.
    const bpm = Number(items?.[wire?.item]?.audioBpm);
    if (Number.isFinite(bpm) && bpm > 0) return playheadBeats(now, lastPulseSeconds(now, bpm), tempo);
  }
  const startTime = Number(state.startTime);
  return playheadBeats(now, Number.isFinite(startTime) ? startTime : 0, tempo);
}

/**
 * Query (reads the plugin registry). WHICH NOTES this midi source has SOUNDING at
 * presentation time `now` — the set a scheduler reconciles the engine against.
 *
 * ── THE STREAM IS ASKED OF `computeOutputs`, WHICH IS WHY THERE IS NO ROSTER ─
 * Every midi source already publishes its notes on its `midi` output port — that is
 * what makes the wire work at all. So the scheduler reads the SAME value a receiver
 * would, and a clip node, an ABC node and any future arpeggiator are all played by
 * this one function with no code per widget. Reading the clip leaf directly would
 * have worked for exactly one of them.
 *
 * ── A SET, NOT AN EVENT QUEUE, AND THAT IS THE WHOLE DESIGN ────────────────
 * The obvious scheduler walks `clipEvents` forward and fires each one as its beat
 * passes. That needs a cursor — state carried from frame N−1 — which CLAUDE.md
 * disqualifies outright: it breaks Δt = 0 reproducibility and frame-range sharding
 * at once, and a seek would either replay the whole prefix or miss every event
 * before it. This asks a PURE QUESTION instead: given `now`, which notes are down?
 * Δt = 0 gives the identical set, so no events are emitted and the frame is
 * byte-identical; a seek to any time answers correctly with no prefix; and the
 * caller turns set-differences into note-ons exactly as `syncLatchedNotes` already
 * turns chord-differences into them.
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @param {string} itemId - the midi source
 * @param {number} now - presentation time, seconds
 * @param {object} [liveStarts] - `{itemId: seconds}` for live-triggered sources
 * @returns {Array<object>} the sounding note records (empty when not playing)
 *
 * @example clipSoundingNotes({}, {get: () => null}, "c", 0) // []
 */
export function clipSoundingNotes(items, registry, itemId, now, liveStarts = {}, liveNow = now) {
  const state = items?.[itemId];
  if (!state || state.active === false) return [];
  let plugin = null;
  try { plugin = registry.get(state.type); } catch { return []; }
  if (!isTriggerableMidiSource(plugin) || typeof plugin.computeOutputs !== "function") return [];
  const beat = clipPlayhead(items, registry, itemId, now, liveStarts, liveNow);
  if (beat === null) return [];
  let notes = [];
  // A producer's own parse (ABC) can be arbitrarily broken source; it must not take
  // out the audio frame. A broken source plays nothing, which is its own rule.
  try { notes = plugin.computeOutputs(state)?.midi ?? []; } catch { return []; }
  return soundingNotes(notes, beat);
}

/**
 * Query (reads the plugin registry). Every midi source in the frame, with the notes
 * each has sounding: `{itemId: [pitch, …]}` — ascending and deduplicated, the shape
 * `core/live_control.latchedChordDelta` diffs.
 *
 * DEDUPLICATED BECAUSE THE CONSUMER IS A VOICE POOL, which keys a note by its
 * number: two overlapping notes at the same pitch are one sounding voice, and
 * sending a second note-on would restart the first one's envelope mid-note.
 * Sources with nothing sounding are OMITTED rather than mapped to `[]`, so the map
 * compares equal to the engine's record when nothing is playing.
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @param {number} now - presentation time, seconds
 * @param {object} [liveStarts] - `{itemId: seconds}` for live-triggered sources
 * @returns {Object<string, number[]>}
 *
 * @example soundingClips({}, {get: () => null}, 0) // {}
 */
export function soundingClips(items, registry, now, liveStarts = {}, liveNow = now) {
  const out = {};
  for (const id of Object.keys(items ?? {})) {
    const notes = clipSoundingNotes(items, registry, id, now, liveStarts, liveNow);
    if (notes.length === 0) continue;
    out[id] = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  }
  return out;
}

/**
 * Query (reads the plugin registry). THE LOUD WARNING for a deck whose clips are
 * triggered by something that will not record — or null when every clip in it is
 * reproducible.
 *
 * ── IT FOLLOWS server.py's playback_clock_warning, DELIBERATELY ────────────
 * Same shape, same reason, same three obligations: NAME the offending nodes, say
 * WHY they will not reproduce, and POINT AT the deterministic alternative. The
 * failure being prevented is identical too — "a user who renders the same deck
 * twice and gets two different videos with no explanation", except that here the
 * second render is not different but SILENT, which is worse because it looks like
 * the feature is broken rather than like the deck is.
 *
 * A WARNING, NOT A REFUSAL. See the file header for why.
 *
 * @param {object} items - the folded item map
 * @param {object} registry - the plugin registry
 * @returns {string|null}
 *
 * @example liveTriggeredClipRefusal({}, {get: () => ({})}) // null
 * @example // a source with nothing wired is the reproducible default
 * @example liveTriggeredClipRefusal({c: {type: "node_midi_clip"}}, {get: () => ({ports: () => ({inputs: [{key: "trigger", type: "trigger"}], outputs: [{key: "midi", type: "midi"}]})})}) // null
 */
export function liveTriggeredClipRefusal(items, registry) {
  const live = [];
  for (const [id, state] of Object.entries(items ?? {})) {
    if (state?.active === false) continue;
    let plugin = null;
    try { plugin = registry.get(state?.type); } catch { continue; }
    // ASKED OF THE PORTS: anything that emits `midi` and takes a trigger has a
    // "when", and therefore a way to get it wrong. Keying on `midiClip` instead —
    // which is what this did first — silently excluded the ABC node (see
    // isTriggerableMidiSource for the hole the user found).
    if (!isTriggerableMidiSource(plugin)) continue;
    if (clipPlaybackKind(items, registry, id) === "live") live.push(id);
  }
  if (live.length === 0) return null;
  return `${live.length} MIDI source${live.length === 1 ? "" : "s"} (${live.join(", ")}) ${live.length === 1 ? "is" : "are"} triggered by a LIVE control — a button or a keyboard, whose press is a human moment with no representation in the document. A recorded export contains no presses, so ${live.length === 1 ? "this clip" : "these clips"} will render SILENT however clearly they play in a live presentation. For an export that reproduces, leave the trigger UNWIRED (it then starts at its own Start Time, which is keyframable document state) or drive it from a Clock, whose pulses are a pure function of elapsed time.`;
}
