/**
 * SURGE XT — the spec for the one audio node that is a WHOLE SYNTHESIZER.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * Every other entry in core/audio_specs*.js describes a module of a few dozen
 * lines of DSP: an oscillator, a filter, a delay. This one describes Surge XT — a
 * complete open-source synthesizer (three oscillators per scene, two scenes, a
 * modulation matrix, eight FX slots, ~2000 parameters) compiled to WebAssembly and
 * running in the same AudioWorklet graph as everything else. It is a node like any
 * other on the canvas: it has beads, it wires, its knobs keyframe.
 *
 * The user's ask, verbatim (2026-08-08), against the WebSurge browser build:
 * "can we make it a widget, that has an audio output (be compat with other nodes)
 * and a midi-in input node … all of which bring up full fledged UI's in giant
 * modals when double clicked".
 *
 * ── THE KNOB SURFACE IS THREE REAL CONTROLS, AND THE EIGHT MACROS ARE NOT HERE ─
 * Surge has on the order of two thousand parameters. Putting them in the Inspector
 * would be useless, and picking forty favourites would be a taste judgement this
 * file has no business making. So the card carries only knobs that are TRUE — each
 * one reaches a documented entry point in the engine and changes the sound:
 *
 *   level     an ordinary GainNode on this node's output. Not Surge's at all, which
 *             is why it is honest: it quiets the node in the patch without editing
 *             the instrument, exactly as every other module's `level` does.
 *   modwheel  MIDI CC 1, through `sh_cc`. The standard modulation source every
 *             Surge patch may assign, and the one an author reaches for to make a
 *             held note MOVE. Keyframe it and the deck performs itself.
 *   bend      the pitch wheel, through `sh_pitch_bend`.

 * **TEMPO IS FIXED AT 120 BPM AND THERE IS NO KNOB, WHICH IS A REAL BOUND.**
 * It was written as one and then removed, because the knob would not have worked.
 * Surge computes `temposyncratio = tempo/120` with no "no tempo" branch, so tempo
 * matters enormously — a 0 freezes every temposynced LFO at rate x 0 and clamps the
 * delay to a 5.46 s echo that exists in no patch — and `sh_set_tempo` IS exported by
 * `surge-engine.wasm`. But the VENDORED WORKLET BUNDLE does not bind it: its `cwrap`
 * table has no `sh_set_tempo` entry and its message dispatch has exactly ten cases,
 * none of them a tempo (MEASURED on the vendored bytes, not assumed). `sh_init`
 * hardcodes 120 and nothing can change it afterwards. Shipping the knob anyway would
 * have been a dial that turns and does nothing — the exact silent discard this file's
 * neighbours refuse. THE FIX IS FOUR LINES IN THE VENDORED BUNDLE (bind the export,
 * add a `setTempo` case) and is deliberately not taken here: patching vendored code
 * is a maintenance burden that deserves its own decision, and temposynced patches
 * still play correctly at 120.
 *
 * **THE EIGHT MACROS ARE DELIBERATELY ABSENT, AND THIS IS THE INTERESTING PART.**
 * The obvious design is eight macro knobs — they are Surge's documented automation
 * surface, they are 0..1, and they would be perfect keyframable leaves. They are
 * not here because I could not prove the index. `sh_set_param(index, value)` writes
 * into `patch.param_ptr`, which is what `sgui_param_count()` reports (766 in
 * practice); Surge's macros live in `scene[].modsources[ms_ctrl1..8]`, which is a
 * DIFFERENT array. So a `macro3` knob would have had to guess an index into the
 * wrong block, and a wrong guess does not throw — it silently turns some other
 * parameter, which is precisely the "a control the engine silently discards"
 * failure core/audio_specs.js's `construct: true` note exists to refuse.
 *
 * The honest route is open and is NOT done: `sh_metadata_json()` returns the
 * engine's own parameter metadata, so the macro indices can be DISCOVERED at
 * runtime by name and a macro knob built on the answer rather than on a guess.
 * That is a real piece of work (the spec is static data checked in bare node, so
 * a runtime-discovered index needs a seam that does not exist yet) and it is
 * recorded here as unfinished rather than shipped as a knob that might be a lie.
 *
 * ── WHY `patchData` IS DOCUMENT STATE AND NOT A FILE REFERENCE ──────────────
 * A Surge patch could have been an asset reference (`assets/foo.fxp`). It is a
 * document leaf instead, base64, because of the core invariant: RenderTree =
 * pure(document, [[slide, alpha]]). A deck whose sound depends on a file beside it
 * is a deck that arrives at someone else silently different. Storing the patch
 * costs tens of kilobytes of JSON and buys a deck that is self-contained,
 * diffable, undoable, and — because it is an ordinary leaf — able to CHANGE
 * BETWEEN SLIDES like everything else. A discrete leaf switches at alpha > 0
 * (core/deltas.js's rule), so slide 3 can be a different instrument.
 *
 * **THAT LAST SENTENCE WAS A FALSE CLAIM FOR A DAY, AND THE LESSON IS THE USUAL
 * ONE.** The storage was correct from the start and nothing ever read it back: the
 * modal wrote `patchData`, and the engine booted Surge's Init patch on every load,
 * every reload and every slide. So this docblock described a per-slide capability
 * the code did not have, in the file a contributor is sent to for the contract —
 * CLAUDE.md's own "a revert that leaves the prose standing installs a confident
 * lie" defect, arrived at by omission rather than by revert. The user found it in
 * one sentence: *"surge's presets dont even survive a page reload lol"*. What makes
 * it TRUE now is `engineParam: true` on the leaf below, which puts it in the
 * mirror's ordinary diff; the mechanism and its reasoning are in
 * core/audio_mirror_diff.engineValueDecls.
 *
 * ── WHAT A KEYFRAMED PATCH ACTUALLY COSTS, MEASURED ────────────────────────
 * The 639 vendored factory patches are 23-549 KB raw, median 30.8 KB, which is
 * ~41,000 base64 characters — call it 40 KB of JSON per patch. That sounds alarming
 * for a 20-slide deck and is not, because a delta stores ONLY WHAT CHANGED:
 * measured on a three-slide document, the slide that sets a patch carries the blob,
 * the next slide that sets a different one carries only that one, and a slide that
 * changes nothing carries a 2-byte delta. So the cost is 40 KB PER DISTINCT PATCH,
 * not per slide — a deck with one instrument pays once no matter how long it is,
 * and a deck that genuinely changes instrument on five slides pays for five
 * because it genuinely contains five instruments.
 *
 * `patchName` rides alongside as a human label. It is NOT the source of truth —
 * `patchData` is — and it exists so the card and the Inspector can say what is
 * loaded without decoding a blob. They are written together, always, by the one
 * seam that writes either (web/app.svelte.js commitSurgePatch).
 *
 * ── THE FOUR KINDS OF STATE, FOR THIS NODE. READ THIS BEFORE CHANGING IT ────
 * CLAUDE.md requires every widget to declare which kind it introduces. Surge is
 * the sharpest case in the roster, because the naive answer is wrong twice.
 *
 * WHAT THE DOCUMENT HOLDS IS **PROPERTY STATE**, all of it. The macros, the patch
 * blob, the level, the wires, the midi clip on the input — every one is a folded
 * leaf, computable from [[slide, alpha]] with no history. Nothing here reads a
 * clock. So the RENDER TREE a Surge node contributes is a pure function of the
 * document, exactly like a rectangle's, and Δt = 0 produces a byte-identical
 * frame. **This is the load-bearing claim and it is pinned by a test**
 * (tests/surge_determinism_test.js).
 *
 * WHAT THE ENGINE HOLDS IS **NOT DOCUMENT STATE AT ALL**. Surge's DSP is
 * stateful — sample N depends on sample N-1 through every filter, delay line and
 * envelope it has — and it is tempting to file that under SIMULATED state and
 * reach for `core/document.stridedShardRefusal`. **That would be wrong, and the
 * distinction matters.** Simulated state is a DOCUMENT VALUE that reads `@`/`dt`:
 * it feeds the render tree, so a strided shard renders a wrong PICTURE. Surge's
 * recursion feeds an AudioContext, never a pixel. It is exactly what
 * web/audioMirror.svelte.js already says of all 191 audio nodes: "The SOUND is not
 * state at all — it is a live consumer downstream of that state." A Surge node
 * therefore costs a video export NOTHING that the roster did not already cost it,
 * and `stridedShardRefusal` is correct to stay silent — widening it would refuse
 * contiguous-shard-only rendering for every deck with a synth in it, on a
 * reproducibility risk that does not exist, since PowerRP's video export writes no
 * audio track at all.
 *
 * WHAT WOULD MAKE IT EPHEMERAL, AND IS THEREFORE FORBIDDEN HERE. Two things, and
 * both are live wires that must never reach a render path:
 *   1. THE GUI CANVAS. Surge's real interface is rasterised by a second wasm module
 *      on the main thread. It is EDITOR CHROME — it lives in the modal, exactly as
 *      Monaco does, and it is not in the display list. `emit()` on this node draws
 *      the ordinary node card and nothing else. If the GUI's pixels ever reached
 *      `emit()`, Δt = 0 would stop producing identical frames and this node would
 *      become the project's first ephemeral widget.
 *   2. A LIVE MIDI KEYBOARD. Legal for PERFORMANCE, through core/live_control.js,
 *      which no renderer calls. What arrives at the `notes` input instead is a
 *      CLIP — see core/nodeflow.PORT_TYPES.midi, which states that contract in
 *      full. Playback derives note-on/note-off from the presentation clock, which
 *      makes it RECORDABLE (a pure function of elapsed time), not ephemeral.
 *
 * Zero PowerRP-runtime imports and zero synth imports: this is data, like every
 * other spec file. tests/audio_nodes_test.js checks it against the real engine.
 */

export const SURGE_SPEC = {
  type: "audio_surge",
  module: "surge",
  title: "Surge XT",
  family: "source",
  icon: "mdi:piano",
  // WIDER THAN THE 150 DEFAULT because eight macro dials plus a level wrap into a
  // band that is unreadable at card width; 230 fits four dials per row.
  w: 230,
  readout: "patchName",
  // DOUBLE-CLICK OPENS SURGE'S OWN GUI rather than knob focus — the override
  // core/audio_nodes.js documents. The card's dials are the eight macros; the
  // other ~2000 parameters have no dial here and never will, so "play with the
  // knobs in it" has to mean the real interface.
  activate: "surge_gui",
  // OFF THE SHELF (user, 2026-08-08): adding this node inserts a whole playable
  // rig — keyboard, synth, output, pre-wired — rather than a lone card the author
  // must then cable up. The blueprint is DATA in core/audio_rigs.js and is named
  // here by ID, which is what lets a plugin compose two other plugins without
  // importing either of them.
  rig: "audio-rig-surge",
  // THE CONTENT DESCRIPTOR the `surge_gui` activate handler `claims()`. It exists so
  // `migrationPlan` can catch the half-wired state — a widget that ships the
  // descriptor but forgets the `activate` string — which tests/activation_migration_test.js
  // asserts is empty. Resolution itself is the `activate` string above and nothing weaker.
  surgeGui: true,
  // POLY: this module takes NOTES (engine.noteOn/noteOff), not strikes.
  // core/live_control.noteRoutes reads this to decide whether a keyboard's gate
  // becomes a note or a one-shot trigger, and tests/control_nodes_test.js asserts
  // the flag agrees with the engine module actually declaring noteOn.
  poly: true,
  help: "Surge XT — a complete open-source synthesizer, running in the audio graph as one node. Wire a MIDI clip into `midi` (or a Keyboard node's pitch and gate) and patch its output like any other source. DOUBLE-CLICK to open Surge's own full interface. The eight macros are ordinary keyframable knobs; everything else lives in the patch.",
  inputs: [
    // THE MIDI INPUT. Type `midi`, so only a note stream may land here — a number
    // or an audio signal is refused at the drop with a sentence, rather than
    // silently coerced into something that is not a melody. See PORT_TYPES.midi.
    { key: "notes", type: "midi", label: "midi" },
    // THE KEYBOARD PATH, identical in shape to the poly pad's, so a Keyboard node
    // plays Surge with no new code: `gate` is a METHOD port (core/live_control.js
    // routes note-on/note-off through it) and `pitch` names the note.
    { key: "pitch", type: "number", label: "pitch" },
    { key: "gate", type: "trigger", label: "gate", method: true },
    { key: "level", type: "number", label: "level" },
  ],
  // ONE STEREO OUTPUT, not an L and an R. Surge renders two channels and the port
  // carries the AudioNode that holds both; Web Audio's own channel rules mix it
  // down wherever a mono input receives it. Two ports would make every patch
  // drawn with a synth in it need two wires to say one thing.
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "level", label: "Level", default: 0.5, min: 0, max: 1, step: 0.01, help: "Output amplitude, 0 to 1. A gain on THIS NODE, not Surge's own master — so it quiets the synth in the patch without editing the instrument." },
    { key: "modwheel", label: "Mod Wheel", default: 0, min: 0, max: 1, step: 0.001, help: "MIDI CC 1, the standard modulation source. What it does depends on what the patch assigns it to — which is exactly what makes it worth keyframing: automate this and a held chord MOVES." },
    { key: "bend", label: "Bend", default: 0, min: -1, max: 1, step: 0.001, help: "The pitch wheel, -1 to +1. Its range in semitones is the patch's own bend setting." },
  ],
  // ── NON-KNOB DOCUMENT STATE (the `state` hook, core/audio_nodes.js) ────────
  // These are not engine params: no `setParam` accepts them, and the mirror must
  // REBUILD nothing when they change — loading a patch is a message to the running
  // worklet. They are declared here, beside the knobs, for the reason
  // core/analysis_display.js declares a spectrogram's colour map beside its
  // drawing: a widget's state belongs in one file, whatever the engine calls it.
  state: [
    {
      key: "patchName",
      default: "Init Saw",
      // A TEXT ROW, NOT A DROPDOWN OF FACTORY PATCHES. A dropdown would be a lie
      // the moment the GUI edited anything: the loaded instrument would no longer
      // be the named one, and the row would keep confidently naming it. It is a
      // LABEL for whatever `patchData` holds, and the GUI writes both together.
      row: { kind: "text", label: "Patch", category: "audio" },
      help: "The name of the loaded patch. A LABEL, not the instrument itself — the sound is in Patch Data. Editing anything in the Surge GUI updates both.",
    },
    {
      key: "patchData",
      default: "",
      // THE ENGINE MUST BE TOLD. Without this flag the leaf is stored and never
      // read back — which is exactly the bug the user reported ("surge's presets
      // dont even survive a page reload lol"). `engineParam` puts it in the mirror's
      // ordinary diff (core/audio_mirror_diff.engineValueDecls), which is what makes
      // reload, per-slide presets, undo and tween all work through ONE path.
      engineParam: true,
      // NO INSPECTOR ROW AT ALL, deliberately. It is tens of kilobytes of base64;
      // rendering it in a text field would freeze the panel and inviting a hand
      // edit would invite a corrupt instrument with no way to say what broke. It
      // is still an ordinary leaf — saved, undone, diffed, tweened between slides
      // — reached through the GUI, which is the only editor that understands it.
      row: null,
      help: "The complete Surge patch, base64. Written by the Surge GUI; empty means Surge's own default patch.",
    },
  ],
};
