/**
 * ABC NOTATION node — type a tune, get a `midi` cable.
 *
 * ── THE ASK (user, 2026-08-08) ──────────────────────────────────────────────
 * "…and abc language output midi nodes". Plus the ruling that shaped it:
 * **"literally having signal as a node is important btw"** — so this is not a
 * property that another widget reads, it is a NODE with a real `midi` OUTPUT PORT
 * and a cable the author drags to an instrument.
 *
 * ── THE SAME STREAM THE CLIP NODE PRODUCES, AND THAT IS THE POINT ──────────
 * `core/abc.js` parses the text into `core/midi_clip.js`'s note records, which is
 * exactly what plugins/node_midi_clip.js emits. A receiver therefore cannot tell
 * which producer it is wired to — an instrument, an arpeggiator or a future
 * notation exporter is written once, and either node can be swapped for the other
 * without touching the patch.
 *
 * ── WHERE THE NOTES LIVE, AND WHY THERE IS NO `clip` LEAF HERE ─────────────
 * The SOURCE TEXT is the document state; the notes are DERIVED from it, freshly,
 * every time. There is deliberately no cached clip leaf, because a cache would be
 * a second copy of the truth that could disagree with the text after an undo, a
 * keyframe or a slide change — and the author edits the TEXT, so the text has to
 * win. The parse is pure and cheap, and the determinism law is satisfied the same
 * way it is for a Mermaid definition: same string, same notes, on every machine.
 *
 * A consequence worth stating rather than discovering: THE PIANO ROLL CANNOT EDIT
 * THIS NODE. Dragging a note would have to rewrite ABC text, which is a
 * source-rewriting problem (formatting, comments, line breaks) and not a note
 * problem. So this widget declares `codeEditor` and gets the Monaco modal, and the
 * clip node declares `midiClip.editable` and gets the piano roll. Two nodes, two
 * editors, one output type — and an author who wants to draw on a tune converts it
 * by wiring, not by fighting a round-trip.
 *
 * ── A BROKEN TUNE OUTPUTS NOTHING, LOUDLY ──────────────────────────────────
 * The project-script precedent, verbatim from CLAUDE.md: "a broken script exports
 * NOTHING so its callers fail through the normal equation-error path". A tune with
 * any parse error yields the EMPTY stream and the card SAYS SO, in red, with the
 * line number and the parser's own sentence. Half a tune is worse than no tune,
 * because half a tune looks like it worked.
 *
 * WHAT SUBSET OF ABC IS SUPPORTED, AND WHAT IS REFUSED, IS STATED EXHAUSTIVELY IN
 * `core/abc.js`'s header. It is the load-bearing half of that file and it is not
 * repeated here — one statement, in the module that enforces it.
 */

import { abcParse } from "../core/abc.js";
import { clipLengthBeats, DEFAULT_TEMPO } from "../core/midi_clip.js";
import { TRIGGER_PORT } from "../core/clip_playback.js";
import { controlDefaults, controlNodeHeight, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, nodeFamily, portBeads } from "../core/node_chrome.js";
import { rect, text } from "../render_gpu/ir.js";

/**
 * The tune a freshly placed node is born with. A REAL, COMPLETE, PLAYABLE tune
 * rather than a placeholder, for the reason plugins/mermaid.js ships a default
 * diagram: a node that arrives empty teaches the author nothing about the syntax
 * and produces silence, so the first thing they see is a widget that appears
 * broken. This one exercises the header fields, a key signature, both octaves,
 * explicit lengths and a bar line — i.e. it is also a worked example.
 */
const DEFAULT_ABC = [
  "X:1",
  "T:Fragment",
  "M:4/4",
  "L:1/8",
  "Q:1/4=100",
  "K:D",
  "DEFG ABcd|d2 c2 B2 A2|",
].join("\n");

const FACE_INSET = 8;
const FACE_BOTTOM_GAP = 8;

/** The face's natural height: enough for the source PREVIEW's handful of lines
 *  plus the status line under it. The card is a REPORT — what tune is loaded, is
 *  it valid, how many notes — because the editing happens in the modal. */
const PREVIEW_LINE_H = 10;
const PREVIEW_LINES = 6;
const STATUS_H = 12;
const GRID_NATURAL_H = PREVIEW_LINES * PREVIEW_LINE_H + STATUS_H;

const PREVIEW_FACE = {
  height: GRID_NATURAL_H, grow: true, inset: FACE_INSET, bottomPad: FACE_BOTTOM_GAP,
};

/**
 * THE PORTS — the SAME pair plugins/node_midi_clip.js declares, and that symmetry
 * is the point rather than a copy.
 *
 * The `midi` OUTPUT is what puts both nodes on the same cable: a receiver cannot
 * tell which producer it is wired to.
 *
 * ── AND THE `trigger` INPUT ANSWERS THE SAME QUESTION THE SAME WAY ─────────
 * USER, 2026-08-08: "how to trigger the abc notation to start playing?" — asked
 * because the clip node had a trigger input and this one did not, which made "when
 * does it play" a question with two different answers depending on how the phrase
 * happened to be authored. It should not be: how a phrase is WRITTEN (drawn in a
 * roll vs typed as ABC) has nothing to do with WHEN it starts.
 *
 * So the three playback kinds and their costs are identical here, and
 * `core/clip_playback.js` owns both. In short: NOTHING WIRED starts at this node's
 * own keyframable `startTime` (RECORDABLE — the default, and it exports); A CLOCK
 * loops it (still RECORDABLE); A BUTTON plays it live and RENDERS SILENT, and is
 * warned about loudly rather than silently different.
 */
const PORTS = {
  inputs: [{ key: TRIGGER_PORT, type: "trigger", label: "trigger" }],
  outputs: [{ key: "midi", type: "midi", label: "midi" }],
};

const DEFAULT_W = 240;
const DEFAULT_H = controlNodeHeight(PREVIEW_FACE, PORTS);

/**
 * Pure function. The parse of this widget's source. THE one entry point every
 * consumer here uses — the painter, the outputs, the problem sentence — so the
 * card, the wire and the Inspector cannot disagree about what the tune says.
 *
 * @param {object} s - the folded item state
 * @returns {{notes: Array, errors: Array, meta: object}}
 *
 * @example abcOf({abc: "K:C\nC"}).notes.length // 1
 * @example abcOf({}).notes // []
 * @example // an absent source is not an error state; it is an empty tune
 * @example abcOf({}).errors.length // 1
 */
export function abcOf(s) {
  return abcParse(s?.abc ?? "");
}

/**
 * Pure function. THE PROBLEM with this widget's tune as ONE SENTENCE, or null.
 *
 * Shows the FIRST error and how many others there are. One sentence rather than a
 * list because it renders on a node card, and a card that grows to fit a stack of
 * parse errors stops being a card; the modal is where the full text lives. The
 * count is included so "there are more" is never implied by omission.
 *
 * @param {object} s - the folded item state
 * @returns {string|null}
 *
 * @example abcProblem({abc: "K:C\nC"}) // null
 * @example abcProblem({abc: "K:C\nC-D"}) // "line 2:2 — a tie MERGES two notes into one longer note; ignoring it would re-articulate the note — write the summed length as a single note"
 * @example abcProblem({abc: "K:C\nC-D-E"}).endsWith("(and 1 more)") // true
 */
export function abcProblem(s) {
  const { errors } = abcOf(s);
  if (errors.length === 0) return null;
  const first = errors[0];
  const rest = errors.length - 1;
  return `line ${first.line}:${first.column} — ${first.message}${rest > 0 ? ` (and ${rest} more)` : ""}`;
}

export const nodeAbcPlugin = controlNodePlugin({
  type: "node_abc",
  title: "ABC Notation",
  icon: "mdi:music-clef-treble",
  ports: PORTS,
  face: PREVIEW_FACE,
  defaults: controlDefaults("node_abc", DEFAULT_W, DEFAULT_H, { abc: DEFAULT_ABC, startTime: 0 }),
  rows: [
    { key: "startTime", label: "Start Time", kind: "number", min: 0, category: CONTROL_CAT, help: "WHEN this tune begins, in seconds on the presentation clock — used when nothing is wired to the trigger input. This is the REPRODUCIBLE way to start it: ordinary keyframable document state, so an export renders it identically every time. Wire a Clock to the trigger to loop it instead; wire a Button and it will play live but render SILENT, because a press is not document state." },
    // `code: {language: null}` puts the `{}` button at the end of this row — the
    // same affordance plugins/mermaid.js's `definition` row carries. `null` rather
    // than a language id because Monaco ships no ABC grammar and this app has not
    // registered one: naming a language it does not have would render as UNCOLOURED
    // PLAINTEXT SILENTLY (web/CodeEditorModal.svelte's MONACO_LANGUAGES note), which
    // is a claim the editor does not honour. Plain text that says it is plain text
    // is the honest option, and an ABC Monarch grammar is a follow-up that would
    // change this one word.
    { key: "abc", label: "ABC", kind: "text", code: { language: null }, category: CONTROL_CAT, help: "The tune, in ABC notation. Edit it here inline or — for a real multi-line edit — in the full-screen editor behind the {} button, or by double-clicking the widget. The supported subset is stated in core/abc.js; anything outside it is refused with the line, the column and what to write instead, and a tune with ANY error outputs no notes at all." },
  ],
  /**
   * DOUBLE-CLICK OPENS THE FULL-SCREEN CODE EDITOR — the user's "full fledged UI's
   * in giant modals when duoble clicked", answered by the modal this app already
   * has rather than by a second one. `activate` is REQUIRED alongside `codeEditor`
   * (tests/activation_migration_test.js: a codeEditor-carrying widget that forgets
   * this string silently loses its double-click).
   */
  activate: "code_modal",
  extra: {
    /**
     * WHICH string the modal edits. **THIS MUST BE INSIDE `extra`, AND THAT COST A
     * BROWSER PROBE TO FIND.** `core/control_nodes.controlNodePlugin` copies a fixed
     * set of named fields plus `...spec.extra` — it does NOT spread unknown
     * top-level keys — so this declaration written one level up was SILENTLY
     * DROPPED. The widget then carried `activate: "code_modal"` with nothing for the
     * handler to read, and double-clicking it threw instead of opening anything.
     *
     * NOTHING WE HAVE CATCHES THAT. `tests/activation_migration_test.js` asserts
     * `migrationPlan` is empty, but that plan reports widgets declaring NO handler —
     * this widget declared one. And the handler's own `claims` (`!!plugin.codeEditor`)
     * is migrationPlan-only, so a false answer there is never consulted. It is the
     * plugins-half of the missing-named-import hazard CLAUDE.md records: the build is
     * green, the declaration is right there in the source, and the feature is dead.
     * `tests/piano_roll_probe.js` now pins the double-click end to end, which is the
     * only place the whole chain is visible.
     *
     * `language: null` rather than an ABC id because Monaco ships no ABC grammar and
     * this app has not registered one: naming a language it does not have renders as
     * UNCOLOURED PLAINTEXT SILENTLY (web/CodeEditorModal.svelte's MONACO_LANGUAGES
     * note), which is a claim the editor does not honour. An ABC Monarch grammar is a
     * follow-up that would change this one word.
     */
    codeEditor: { property: "abc", language: null, title: "Edit ABC Notation" },
    /** Published FACTS about the tune, in `extra` for the same reason `codeEditor`
     *  is — `controlNodePlugin` spreads only `extra`, and a top-level declaration
     *  here would be dropped without a word. */
    outputProps: {
    /** THE TUNE'S OWN TEMPO, published so a receiver can schedule it and an
     *  equation can read it. There is no tempo PROPERTY on this widget, on purpose:
     *  the tune states its own tempo in its `Q:` field, and a second stored number
     *  beside it would be a source of truth that could disagree with the text the
     *  author is editing. A tune with no `Q:` reports the model's default. */
    tempo: {
      label: "Tempo", kind: "number",
      value: (s) => abcOf(s).meta.tempo ?? DEFAULT_TEMPO,
      help: "Beats per minute, read from the tune's own Q: field (120 when it has none). Read it from any equation as \"= <name>.tempo\" to keep a receiver in step with the notation.",
    },
    /** THE TUNE'S LENGTH IN BEATS — what a loop, a transition or a bar counter
     *  wants, and the one number that is genuinely tedious to work out by hand
     *  from a page of ABC. */
    beats: {
      label: "Beats", kind: "number",
      value: (s) => clipLengthBeats(abcOf(s).notes),
      help: "How long the tune is, in beats, from 0 to the end of its last note. 0 when the tune is empty or will not parse.",
      },
    },
  },
  /**
   * Pure function. THE GRAPH-VISIBLE OUTPUT: the parsed tune, as the note-record
   * array `core/nodeflow.PORT_TYPES.midi` declares.
   *
   * A BROKEN TUNE PRODUCES THE EMPTY STREAM (see the file header), which is the
   * type's own zero — so a receiver wired to a broken tune plays silence rather
   * than a fragment, and needs no special case to do it.
   *
   * @example nodeAbcPlugin.computeOutputs({abc: "K:C\nC"}).midi.length // 1
   * @example nodeAbcPlugin.computeOutputs({abc: "K:C\nC"}).midi[0].pitch // 60
   * @example // a REFUSED construct yields no notes at all, never a fragment
   * @example nodeAbcPlugin.computeOutputs({abc: "K:C\nC-D"}).midi // []
   */
  computeOutputs(s) {
    return { midi: abcOf(s).notes };
  },
  /**
   * Pure function. The card, a few lines of the source, and the status line.
   *
   * THE SOURCE PREVIEW IS TRUNCATED, VISIBLY. A tune is routinely longer than a
   * node card, so the preview shows the first few lines and says how many it did
   * not show. Silently cutting it would leave an author unable to tell a
   * three-line tune from the first three lines of a thirty-line one.
   *
   * EVERYTHING HERE IS DOCUMENT STATE — the text and its parse. There is no
   * playhead and no clock, so Δt = 0 gives a byte-identical frame.
   *
   * @param {object} s - the folded item state
   * @param {object} face - the preview's rect, HANDED here by the factory (R7-10)
   */
  paint(s, face) {
    const { notes, errors } = abcOf(s);
    const accent = nodeFamily(CONTROL_FAMILY).rim;
    const ops = [...familyCard(s, nodeAbcPlugin.title, CONTROL_FAMILY)];
    ops.push(rect({ x: face.x, y: face.y, w: face.w, h: face.h, cornerRadius: 2, fill: SOURCE_BG_INK }));
    // ── THE SOURCE ───────────────────────────────────────────────────────────
    const lines = String(s?.abc ?? "").split(/\r\n|\r|\n/);
    const room = Math.max(0, Math.floor((face.h - STATUS_H) / PREVIEW_LINE_H));
    const shown = lines.slice(0, room);
    for (let i = 0; i < shown.length; i++)
      ops.push(text({
        text: shown[i], x: face.x + SOURCE_PAD, y: face.y + SOURCE_PAD + (i + 1) * PREVIEW_LINE_H - 2,
        size: SOURCE_SIZE, color: /^[A-Za-z]:/.test(shown[i]) ? SOURCE_FIELD_INK : SOURCE_INK,
        boxW: Math.max(0, face.w - SOURCE_PAD * 2), boxStyle: { align: "left" },
      }));
    // ── THE STATUS LINE ──────────────────────────────────────────────────────
    // The error WINS the line when there is one: a card showing "12 notes" beside a
    // parse failure would be stating a number that is not true of the output.
    const hidden = lines.length - shown.length;
    const status = errors.length > 0
      ? abcProblem(s)
      : `${notes.length} note${notes.length === 1 ? "" : "s"}${hidden > 0 ? ` · ${hidden} more line${hidden === 1 ? "" : "s"}` : ""}`;
    ops.push(text({
      text: status, x: face.x + SOURCE_PAD, y: face.y + face.h - STATUS_BASELINE_GAP,
      size: STATUS_SIZE, color: errors.length > 0 ? ERROR_INK : accent,
      boxW: Math.max(0, face.w - SOURCE_PAD * 2), boxStyle: { align: "left" },
    }));
    ops.push(...portBeads(nodeAbcPlugin, s));
    ops.push(...familyRim(s, CONTROL_FAMILY));
    return ops;
  },
});

/** The source panel. A near-black well behind the text so the card reads as
 *  "there is code in here" at a glance, and a distinct ink for HEADER FIELDS so
 *  the `K:`/`M:`/`L:` block separates from the tune body without a second font. */
const SOURCE_BG_INK = "#161a24";
const SOURCE_INK = "#9aa4bb";
const SOURCE_FIELD_INK = "#6f7a94";
const SOURCE_SIZE = 8;
const SOURCE_PAD = 4;
/** The status line: the note count, or the first parse error. RED for the error,
 *  the family accent for the count — the one place this card carries a colour that
 *  is not the family's, because a failure that read as ordinary chrome is the
 *  silent-wrongness this widget exists to avoid. */
const STATUS_SIZE = 8;
const STATUS_BASELINE_GAP = 3;
const ERROR_INK = "#f7768e";
