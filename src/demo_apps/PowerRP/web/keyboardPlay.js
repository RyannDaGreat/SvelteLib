/**
 * KEYBOARD PLAY — double-click a Keyboard node and play it with the computer
 * keyboard (web/widget_handlers.js, phase "activate").
 *
 * ── THE ASK (user, 2026-08-03, verbatim) ────────────────────────────────────
 * "WHen  I double click a keyboard, my mouse keyboard shoulld be able to use it
 * (see VoiceThing - its a reference app … that has a keyboard in it - use those
 * keys as reference. Make it clear that this is happening - the widget should show
 * a keyboard icon on it and change color a bit when selected, and show all the key
 * regular keyboard names qwerty etc names on the piano keyboard)"
 * (Voice typo: "my mouse keyboard" = my computer keyboard.)
 *
 * The KEYS are VoiceThing's, transposed once: plugins/node_keyboard.js
 * QWERTY_KEY_NOTES cites the file and states the transposition. THIS file owns the
 * MODE — how you get in, what happens while you are in it, and how you get out.
 *
 * ── ENTRY AND EXIT ARE THE KNOB-FOCUS GRAMMAR, DELIBERATELY UNCHANGED ───────
 *   DOUBLE-CLICK the keyboard   enter play mode on THAT keyboard
 *   a mapped computer key       sound its note, and light the piano key
 *   releasing that key          release the note, and un-light it
 *   PRESS a piano key           the ordinary pointer play, exactly as outside
 *   PRESS a port BEAD           the wire gesture, exactly as outside
 *   PRESS anywhere else         leave
 *   ESCAPE                      leave
 *
 * Every line of that is web/knobFocus.js's table with "dial"/"turn" replaced by
 * "key"/"play", and matching it is the point rather than a coincidence: the two
 * modes sit on the same widget family, are entered by the same gesture, and a user
 * who has learned one must not have to learn the other. In particular the
 * press-elsewhere-EXITS rule and the bead-still-wires rule are copied WITH their
 * reasons — a bead is the always-active layer and a mode may not cover it (wave
 * 2's delete-gesture incident), and a body press that sometimes moved the node and
 * sometimes did something else would make both feel unreliable.
 *
 * WHAT IS NOT COPIED, and why: knob focus is now OPTIONAL, because WORKSTREAM BX
 * made dials drag-active without it. This mode is NOT optional and cannot be,
 * because what it takes over is THE ALPHABET. Q must mean "play C5" only while the
 * user has said so, and mean whatever it always meant the rest of the time.
 *
 * ── SELECTION IS NOT THE MODE, AND THAT IS THE SAFETY PROPERTY ──────────────
 * Clicking a keyboard selects it and changes NOTHING about typing. Only the
 * double-click arms the letters. A selected-but-not-playing keyboard that
 * swallowed keystrokes would break every shortcut in the app for as long as the
 * user happened to have a keyboard selected — a modal input hidden inside a
 * document, which is exactly the objection the widget's own v1 docblock raised
 * against doing this at all. The probe asserts the negative case for that reason.
 *
 * ── IT RIDES THE SHORTCUT REGISTRY; IT DOES NOT BYPASS IT ───────────────────
 * The manifest's rule is that the registry BOTH dispatches keydowns AND feeds the
 * HintBar, so a key that is not registered does not exist. So PLAYABLE_MODE_KEYS
 * below is a `mode.keys` declaration — one registry entry per mapped key, scoped
 * `when: inCanvasMode("keyboard_play")` by core/shortcut_entries.js, dispatched by
 * the same `dispatch()` every other shortcut goes through. Nothing here reads a
 * keydown for a NOTE.
 *
 * TWO CONSEQUENCES FALL OUT OF THAT, AND BOTH ARE FEATURES:
 *   The mode's keys are INERT outside the mode, by construction — the `when`
 *     predicate is the same one that dims every other mode's chips.
 *   A key bound elsewhere is not "stolen": `dispatch()` returns the FIRST entry
 *     whose `when` passes, and while the mode is live `editMode` is false for the
 *     ordinary editor entries (they exclude `canvasMode`), so there is exactly one
 *     live meaning per key. That is the registry's existing modal-takeover
 *     behaviour, not a new rule.
 *
 * ── THE ONE THING THE REGISTRY CANNOT DO: KEY-UP ────────────────────────────
 * `dispatch()` only ever reads keydown (core/shortcuts.js says so, and the
 * gesture-honesty guard is built on it). A piano needs the RELEASE: a note-on with
 * no note-off holds a poly voice's envelope open forever — the drone with no
 * visible source that web/audioMirror.releaseAllLiveNotes exists to prevent.
 *
 * So the release rides a plain `keyup` listener, installed on ENTRY and removed on
 * EXIT, and that is NOT a registry bypass — it binds no key, claims no combo,
 * announces nothing, and can refuse nothing. It is the TAIL of a press the
 * registry already dispatched, the same way `finishLivePlay` is the tail of a
 * pointerdown the canvas dispatched. A keyup for a key that never played is
 * ignored, so it cannot consume anything.
 *
 * ── AUTO-REPEAT IS DROPPED AT THE PRESS, NOT AT THE ENGINE ─────────────────
 * Holding a key fires keydown at the OS repeat rate (~30/s). Re-sending noteOn
 * would retrigger the envelope 30 times a second — a buzz rather than a held note,
 * and on a poly module it would keep stealing that note's own voice. `playKey`
 * therefore returns early on a note already held. This is the identical guard
 * CanvasView's `livePlayMove` applies to a glissando, for the identical reason.
 */

import { pressNote, pressedNotes, releaseNote } from "../core/live_control.js";
import { portAt } from "../core/nodeflow.js";
import { keyToken } from "../core/shortcuts.js";
import { QWERTY_KEY_NOTES, keyboardNoteForKey, playableKeys } from "../plugins/node_keyboard.js";

/**
 * Pure function. The registry entries for every key in the mapping.
 *
 * ── WHY ALL OF THEM, RATHER THAN THIS KEYBOARD'S OWN ───────────────────────
 * The registry is built ONCE at boot (App.svelte), and which keys a given
 * keyboard can play depends on its `octaves` — an item property that is
 * keyframable and edited long after boot. A registry rebuilt per keyboard is not
 * something the registry supports, and would make the HintBar depend on the
 * selection in a way nothing else does. So EVERY mapped key registers, and
 * `app.playKeyboardKey` refuses the ones this particular keyboard does not reach
 * (`playableKeys` is the filter, and it is the same list the widget LABELS from,
 * so an unlabelled key is exactly a key that will not sound).
 *
 * ── ONE VISIBLE CHIP, THIRTY-SEVEN HIDDEN ALIASES OF IT ────────────────────
 * Thirty-eight chips is not a hint bar, it is a wall: it would push every other
 * chip in the app off the bar for the duration of the mode, which is the opposite
 * of what the bar is for. So all 38 entries share ONE LABEL and only the first is
 * visible — the rest are `hidden` aliases of it.
 *
 * THAT IS THE REGISTRY'S EXISTING ALIAS RULE, USED FOR WHAT IT MEANS, and getting
 * this wrong once is why the reasoning is written down. The first version made all
 * 38 hidden with a label each ("Play Q", "Play W", …), which
 * tests/shortcut_registry_test.js refused by name: `hidden` is legitimate ONLY for
 * an entry that is an ALIAS of a visible chip meaning the same thing
 * (Delete↔Backspace, Space↔Enter), and the alias relationship is expressed as a
 * SHARED LABEL so it is checkable. Thirty-eight distinct hidden labels are 38 live
 * keys the bar never mentions — "a shortcut that isn't registered does not exist",
 * violated from inside the registry.
 *
 * A SHARED LABEL IS ALSO THE TRUER DESCRIPTION. These keys do not do 38 things;
 * they do ONE thing — play the note printed on them — with 38 arguments, exactly
 * as Delete and Backspace do one thing with two keys. And the per-key answer is
 * where it belongs: ON THE WIDGET, at full size, printed on the key it plays.
 *
 * @returns {{keys: string[], label: string, verb: string, method: string, hidden: boolean}[]}
 *
 * @example playModeKeys().length // 38
 * @example playModeKeys()[0].method // "playKeyboardKey"
 * @example // ONE visible chip; the rest are aliases of it, which is what makes
 * @example // them legitimately chipless
 * @example playModeKeys().filter((k) => !k.hidden).length // 1
 * @example new Set(playModeKeys().map((k) => k.label)).size // 1
 * @example playModeKeys()[0].label // "Play the note printed on the key"
 * @example playModeKeys().find((k) => k.verb === "Q").keys // ["Q"]
 */
export function playModeKeys() {
  return Object.keys(QWERTY_KEY_NOTES).map((key, i) => ({
    keys: [key],
    label: PLAY_KEY_LABEL,
    verb: key,
    method: "playKeyboardKey",
    hidden: i > 0,
  }));
}

/** The one label all 38 play keys share — see playModeKeys on why it is shared. */
const PLAY_KEY_LABEL = "Play the note printed on the key";

/** The mode's registry entries, built once — `canvasModes()` reads this at boot. */
const PLAYABLE_MODE_KEYS = playModeKeys();

/**
 * THE NOTE SINK — where a played note goes, injected rather than imported.
 *
 * ── WHY THIS IS NOT JUST `import { playLiveNote } from "./audioMirror.svelte.js"` ─
 * MEASURED, not theorised. That import was the first version, and it turned 57
 * bare-node suites red in one commit. The chain is short and it is structural:
 * `web/widget_handlers.js` imports this file to register the handler; the node
 * suites and `tests/doctest_test.js` import `widget_handlers.js`; and
 * `audioMirror.svelte.js` declares `$state`, which does not exist outside Vite. So
 * ANY module the handler registry can reach is host-bound-free by construction —
 * a rule this file now sits behind rather than beside.
 *
 * The sink is set once by web/CanvasView.svelte, which is a component and may
 * import anything. Until then a played note is DROPPED, deliberately and not
 * silently-in-the-bad-sense: the picture (the lit key) is driven by
 * core/live_control's press set and does not depend on this at all, so a note
 * played before the canvas mounted lights correctly and simply makes no sound —
 * which is also what happens when the audio engine is not running, and what
 * web/audioMirror's own header says a press while muted means.
 */
let noteSink = null;

/**
 * Command. Installs the function that turns a played note into engine calls.
 * web/CanvasView.svelte passes `playLiveNote`; a probe may pass a recorder.
 *
 * @param {Function|null} fn - (items, registry, itemId, phase, note, frequency) => void
 */
export function setNoteSink(fn) {
  noteSink = fn;
}

/** Command. Sends one note to the sink, if one is installed. */
function sound(app, itemId, phase, note, frequency) {
  noteSink?.(app.state()?.items ?? {}, app.registry, itemId, phase, note, frequency);
}

/**
 * Pure function. WHICH NOTE a computer key plays on this keyboard, or null when
 * the key is outside the mapping OR outside THIS keyboard's drawn range.
 *
 * THE RANGE CHECK IS THE HALF THAT MATTERS, and it is why this exists rather than
 * calling `keyboardNoteForKey` directly. That function answers "what would this
 * key be", which for a one-octave keyboard includes notes it does not draw. A note
 * with no key on screen would sound from a press the user cannot see land — the
 * silent-failure shape this project forbids, and the reason the LABELS and this
 * gate read the same `playableKeys` list.
 *
 * @param {object} state - the keyboard's folded item state
 * @param {string} key - a registry key token
 * @returns {{note: number, frequency: number}|null}
 *
 * @example playableNoteForKey({baseNote: 48, octaves: 2}, "Q").note // 60
 * @example // Q is mapped, but a ONE-octave keyboard does not draw its note
 * @example playableNoteForKey({baseNote: 48, octaves: 1}, "Q") // null
 * @example playableNoteForKey({baseNote: 48, octaves: 1}, "Z").note // 48
 * @example // an unmapped key is null in either range
 * @example playableNoteForKey({baseNote: 48, octaves: 2}, "F") // null
 */
export function playableNoteForKey(state, key) {
  const hit = keyboardNoteForKey(state, key);
  if (!hit) return null;
  return playableKeys(state).some((k) => k.key === key) ? hit : null;
}

/**
 * THE KEYS CURRENTLY HELD BY THE COMPUTER KEYBOARD, as `key token → note`.
 *
 * Module scratch, the discipline web/knobFocus.js's `turning` keeps: at most one
 * play mode can exist (there is at most one `app.canvasMode`), it is cleared on
 * every entry and every exit, and it is never written to the document.
 *
 * IT IS KEYED BY THE COMPUTER KEY, NOT BY THE NOTE, and that is load-bearing: the
 * reference mapping is NOT injective (`,` and `Q` are both C5), so two keys can be
 * holding the same note. Keyed by note, releasing `Q` would silence a note `,` was
 * still holding down.
 */
let heldKeys = new Map();

/** Query. The computer keys currently held, for the overlay and the probe. */
export function currentHeldKeys() {
  return [...heldKeys.keys()];
}

/**
 * Command. Drop all transient play state, WITHOUT sounding anything. Called on
 * entry, where there is by definition nothing held.
 *
 * Separate from `releaseHeldKeys` because the two differ in whether the ENGINE is
 * told: entry clears a map that should already be empty, exit must send the
 * note-offs. Conflating them is how a mode leaves a drone behind.
 */
export function resetKeyboardPlay() {
  heldKeys = new Map();
}

/**
 * Command. Release every held computer key — note-offs to the engine AND the
 * lights off — for `itemId`.
 *
 * WHAT EXIT OWES A HELD CHORD. A mode left with three keys down (Escape while
 * playing, a click on empty canvas, a slide change) has three note-ons the keyup
 * listener will never see, because the listener is removed with the mode. Every
 * exit path therefore runs this.
 *
 * @param {object} app - the app store (for the item map and the registry)
 * @param {string} itemId - the keyboard's item id
 */
export function releaseHeldKeys(app, itemId) {
  for (const note of heldKeys.values()) {
    sound(app, itemId, "off", note, 0);
    releaseNote(itemId, note);
  }
  if (heldKeys.size > 0) app.bumpPressEpoch();
  heldKeys = new Map();
}

/**
 * Command. A computer key went down: sound its note and light its piano key.
 *
 * ONE STATEMENT DOES BOTH, which is the fix for the reported defect ("The keyboard
 * doesn't press keys visually when I touch it"): the sound and the picture read
 * one set, so a key that sounds is a key that lights, by construction rather than
 * by two call sites agreeing to stay in step.
 *
 * @param {object} app - the app store
 * @param {string} itemId - the keyboard's item id
 * @param {object} state - its folded item state
 * @param {string} key - the registry key token that went down
 * @returns {boolean} whether the key played (false = not mapped, or out of range,
 *     or already held)
 */
export function playKey(app, itemId, state, key) {
  // AUTO-REPEAT LANDS HERE, ~30 times a second while a key is held. Re-sounding
  // would retrigger the envelope on every repeat.
  if (heldKeys.has(key)) return false;
  const hit = playableNoteForKey(state, key);
  if (!hit) return false;
  heldKeys.set(key, hit.note);
  pressNote(itemId, hit.note);
  app.bumpPressEpoch();
  sound(app, itemId, "on", hit.note, hit.frequency);
  return true;
}

/**
 * Command. A computer key came up: release its note and un-light its piano key.
 *
 * A KEY THAT NEVER PLAYED IS IGNORED — an ordinary consequence of typing a
 * shortcut before entering the mode, or of a key held across the entry.
 *
 * IT RELEASES THE NOTE ONLY IF NO OTHER HELD KEY IS SOUNDING IT. The mapping is
 * not injective, so `,` and `Q` can both hold C5; releasing one while the other is
 * down must not cut the note, and must not un-light the piano key that the other
 * is still pressing.
 *
 * @param {object} app - the app store
 * @param {string} itemId - the keyboard's item id
 * @param {string} key - the registry key token that came up
 * @returns {boolean} whether anything was released
 */
export function releaseKey(app, itemId, key) {
  const note = heldKeys.get(key);
  if (note === undefined) return false;
  heldKeys.delete(key);
  if ([...heldKeys.values()].includes(note)) return true;
  releaseNote(itemId, note);
  app.bumpPressEpoch();
  sound(app, itemId, "off", note, 0);
  return true;
}

/**
 * Query. The piano keys lit on `itemId` — what the overlay paints, in local
 * card coordinates.
 *
 * SCREEN-SPACE OVERLAY, NOT THE DISPLAY LIST, for the reason the analysis meters
 * are: a press is live input, and painting it in `emit()` would make a PNG export
 * of a slide depend on what the author was holding down. This returns the LOCAL
 * rects; CanvasView maps them through the node's own world transform, so a rotated
 * or scaled keyboard's lit keys follow its card.
 *
 * ONE PRESS SET SERVES BOTH ENTRANCES. Pointer presses (CanvasView's
 * `startLivePlay`) and typed presses (`playKey`) both write core/live_control's
 * set, so this lights a key the same way whichever hand played it — which is what
 * makes the user's original report ("doesn't press keys visually when I touch it")
 * fixed for the touch case and not only for the typed one.
 *
 * @param {object} node - the derived render node (its plugin and state)
 * @returns {Array<{note: number, x: number, y: number, w: number, h: number, black: boolean}>}
 */
export function litKeyRects(node) {
  const held = pressedNotes(node.itemId);
  if (held.length === 0) return [];
  const keys = node.plugin?.keyboardKeys?.(node.state) ?? [];
  return keys.filter((k) => held.includes(k.note));
}

export const KEYBOARD_PLAY_HANDLER = {
  id: "keyboard_play",
  phase: "activate",
  label: "Play with the computer keyboard",
  /** Pure function. `playableKeys` is this handler's CONTENT declaration: a widget
   *  that says which computer keys play which of its notes wants this trigger.
   *  Read ONLY by widget_handlers.migrationPlan, so a widget shipping the table
   *  and forgetting `activate: "keyboard_play"` fails the suite rather than
   *  silently losing the mode.
   *  @example KEYBOARD_PLAY_HANDLER.claims({playableKeys: () => []}) // true
   *  @example KEYBOARD_PLAY_HANDLER.claims({type: "rect"}) // false */
  claims(plugin) {
    return !!plugin.playableKeys;
  },
  /**
   * Command. Enters play mode on the double-clicked keyboard, and installs the
   * keyup listener the registry cannot provide (see the file header).
   *
   * SELECTS FIRST, exactly as knob focus does: the Inspector should be showing the
   * widget you are about to play, and `app.selection` is what it reads.
   */
  run(ctx) {
    resetKeyboardPlay();
    ctx.app.selection = ctx.node.itemId;
    installKeyUp(ctx.app, ctx.node.itemId);
    ctx.enterMode();
  },
  mode: {
    label: "Play keyboard",
    // NO "type to play" HINT HERE, deliberately: the play keys themselves now carry
    // one visible chip saying exactly that (playModeKeys), and a second entry with
    // the same meaning on a DIFFERENT key would be the bar telling the user to
    // press Space to play — a wrong instruction, which the registry's retired-token
    // note calls worse than a missing one.
    hints: [
      { keys: ["mouse_left"], label: "Click a key to play it" },
    ],
    keys: PLAYABLE_MODE_KEYS,
    /**
     * Command. THE PRESS, routed the same three ways knob focus routes its own —
     * a bead is handed back, the widget's own face is played, anything else exits.
     *
     * A PIANO KEY RETURNS "release", NOT a consumed press, and that is the whole
     * of the pointer story here: CanvasView's `startLivePlay` is the always-active
     * live-play layer and it already plays this widget correctly, with capture,
     * glissando and note-off. Consuming the press here would mean reimplementing
     * all three inside the mode and then keeping the two copies in step. Handing
     * it back means pointer play behaves IDENTICALLY in and out of the mode, which
     * is also what the user gets to assume.
     */
    onPick(ctx, pick) {
      const { app, node, plugin } = ctx;
      // The bead layer first, unchanged (core/node_knobs.knobAt's ruling: a bead
      // has no second route, so it outranks everything it overlaps).
      if (plugin.livePlay?.noteAt(node.state, pick.local.x, pick.local.y)) return "release";
      if (portAtLocal(plugin, node.state, pick.local)) return "release";
      releaseHeldKeys(app, node.itemId);
      resetKeyboardPlay();
      app.exitCanvasMode();
    },
    // NO `onExit` HOOK — there is none to declare (web/knobFocus.js records why:
    // a mode can be left by Escape, a slide change, a purge or the presenter, four
    // paths through app.exitCanvasMode() that reach no handler descriptor). The
    // teardown that MUST run on every one of them — note-offs for a held chord and
    // the keyup listener's removal — therefore hangs off `app.canvasMode` going
    // null, watched by the $effect in web/CanvasView.svelte. Clearing on ENTRY is
    // idempotent and covers the paths that run no code of ours.
  },
};

/** Query. The port bead under a LOCAL point, or null. Wraps core/nodeflow.portAt
 *  at zero tolerance — the mode has no zoom to convert a screen slop from, and the
 *  always-active bead layer in CanvasView applies the real one on the press that
 *  actually starts a wire. */
function portAtLocal(plugin, state, local) {
  return portAt(plugin, state, local.x, local.y, 0);
}

/**
 * THE LIVE KEYUP LISTENER, or null. Module scratch like `heldKeys`: at most one
 * play mode exists, so at most one listener does.
 */
let keyUpListener = null;

/**
 * Command. Installs the keyup listener for `itemId`, replacing any previous one.
 *
 * ── WHY IT IS NOT GUARDED BY `isTypingTarget` THE WAY onKeydown IS ──────────
 * It does not need to be, and adding the guard would create a bug. The listener
 * only ever releases a key that `playKey` recorded, and `playKey` only ever runs
 * from a registry dispatch that App.svelte ALREADY gated on `isTypingTarget`. So
 * nothing can be held that was not typed at the canvas. Guarding the RELEASE would
 * mean a key pressed at the canvas and released after focus moved to a field stays
 * held forever — a stuck note, from a guard added for symmetry.
 *
 * @param {object} app - the app store
 * @param {string} itemId - the keyboard's item id
 */
function installKeyUp(app, itemId) {
  removeKeyUp();
  keyUpListener = (e) => releaseKey(app, itemId, keyUpToken(e));
  window.addEventListener("keyup", keyUpListener);
}

/** Command. Removes the keyup listener, if one is installed. Idempotent, because
 *  every exit path calls it and several can run in sequence. */
export function removeKeyUp() {
  if (!keyUpListener) return;
  window.removeEventListener("keyup", keyUpListener);
  keyUpListener = null;
}

/**
 * Pure function. A keyup event's REGISTRY TOKEN — what `playKey` stored the key
 * under, so the release can find it.
 *
 * IT UPPERCASES, and that is the entire subtlety: `core/shortcuts.keyToken`
 * returns `event.key` verbatim ("q"), while the registry's entries are UPPERCASE
 * ("Q") because that is the one spelling `isPrintableKeyToken` admits — and
 * `dispatch()` hides the difference by comparing case-insensitively. A release
 * that compared raw would never match a letter, so every typed note would hang.
 *
 * @param {KeyboardEvent} e - the keyup event
 * @returns {string} the registry token
 *
 * @example keyUpToken({key: "q"}) // "Q"
 * @example keyUpToken({key: ";"}) // ";"
 * @example keyUpToken({key: "2"}) // "2"
 * @example // a SHIFTED punctuation key releases the note its unshifted face played
 * @example keyUpToken({key: "Shift"}) // "SHIFT"
 */
export function keyUpToken(e) {
  return keyToken(e).toUpperCase();
}
