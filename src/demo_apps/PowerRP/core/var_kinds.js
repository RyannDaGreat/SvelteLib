/**
 * GLOBAL VARIABLE KINDS (workstream COMPOUND_, backburner CX) — the pure half.
 * DOM-free (bare-node testable); web/VariablesPanel.svelte renders over these
 * functions and holds none of the reasoning.
 *
 * ── WHAT THE USER ASKED FOR (verbatim) ────────────────────────────────────────
 * "It does seem that global variables don't have any ability to set type inside
 * the UI. That's a bit of a bug. There are several types of properties. We should
 * be able to set which type of property a given variable is as a global variable."
 * and, separately: "Is a font property something we can have? If so, why not just
 * do it that way?"
 *
 * ── THE BUG IS REAL AND IT IS A UI BUG, NOT A MODEL ONE ──────────────────────
 * `state.vars` has ALWAYS been able to hold any JSON value — it is an ordinary
 * keyframed subtree, and `keyframed(doc, i, ["vars", name], v)` never inspected
 * `v`. What was missing is that the PANEL only ever mounted a NumericField, so
 * every variable was born as 0 and could only ever be edited as a number: a
 * colour variable was expressible in the document and unreachable in the app.
 * That asymmetry is exactly the user's "that's a bit of a bug".
 *
 * ── WHY THE KIND LIVES IN `meta`, NOT BESIDE THE VALUE ───────────────────────
 * The tempting shape is `vars: {name: {value, kind}}`, and it is wrong twice.
 *   1. IT WOULD BREAK EVERY EQUATION READER. `core/expressions.js` resolves a
 *      bare identifier by reading `state.vars[name]` and using it AS the value.
 *      Wrapping it in a record makes `speed * 2` multiply an object, and there is
 *      no migration that saves an old document's equations from that.
 *   2. A KIND IS NOT PER-SLIDE STATE. Values tween; a variable does not become a
 *      colour halfway through a transition. Storing the kind in the keyframed
 *      fold would let two slides disagree about what a variable IS, which is a
 *      question with no sensible tween and no sensible answer at alpha 0.5.
 * So the kind is `meta.varKinds` — a flat {name: kind} map beside `meta.script`,
 * exactly the precedent that field set (a first-class meta field, filled quietly
 * when absent, discarded LOUDLY when the wrong type). The VALUE stays exactly
 * where it always was, so every equation, every keyframe and every saved document
 * is byte-identical.
 *
 * ── ABSENT IS "number", AND THAT IS WHAT MAKES THIS A NON-MIGRATION ──────────
 * Every variable written before kinds existed is a number, and `varKind` answers
 * "number" for a name with no entry. So a pre-feature document loads, renders and
 * re-saves identically, and the map only ever grows entries the author asked for
 * (`withVarKind` DELETES an entry set back to number rather than storing the
 * default — a redundant entry would be a diff in every file for no change).
 *
 * ── THE FONT KIND IS REAL, AND ITS BOUNDARY IS STATED RATHER THAN HIDDEN ─────
 * The user asked "Is a font property something we can have? If so, why not just
 * do it that way?" — and the answer is that one already exists, so this kind
 * REUSES it rather than inventing a parallel one. It is NOT in `PROPS`: the font
 * row is declared by `plugins/text.js` as `{key: "font", kind: "select", options:
 * fontOptions()…}` over `render_gpu/fonts.js`'s registry. So a font VARIABLE is a
 * `select` variable whose options come from that same `fontOptions()` roster —
 * one roster, one control, and a face added to the registry appears in both
 * places at once with nothing to keep in step. (`fontOptions` lives in
 * render_gpu/ but the module is deliberately DOM-free and "importable in bare
 * node", which is why core may read it.)
 *
 * WHAT A FONT VARIABLE CANNOT DO is stated in `VAR_KIND_NOTES`: a text widget's
 * Font row must be BOUND to it by an equation (`= titleFont`) like any other
 * property, because nothing in this app makes a widget follow a variable it was
 * never pointed at. That is the same contract every other kind has; it is written
 * down because "why didn't my text change?" is the question a font variable
 * invites.
 */

import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";

/**
 * Pure function. The `select` row aspects a FONT-kind variable's editor needs —
 * the option ids and their labels, straight from the ONE font registry the text
 * widget's own Font row reads (`render_gpu/fonts.js fontOptions`).
 *
 * IT IS A FUNCTION, NOT A CONSTANT, because the roster is not fixed at import:
 * `registerFontFamily` adds dynamically-loaded faces, and a constant snapshotted
 * at module load would show the author a picker missing the font they just added.
 *
 * @example fontVarRowAspects().options[0] // "system"
 * @example fontVarRowAspects().optionLabels.system // "System UI"
 */
export function fontVarRowAspects() {
  const opts = fontOptions();
  return {
    options: opts.map((o) => o.value),
    optionLabels: Object.fromEntries(opts.map((o) => [o.value, o.label])),
  };
}

/**
 * THE KINDS a global variable may declare, in picker order. Each names a ROW KIND
 * from core/properties.js's `ROW_KINDS` — deliberately, so the panel mounts the
 * SAME control the Property Panel would for a property of that kind, rather than
 * a second family of variable-only editors that could drift from it.
 *
 * `number` FIRST because it is the default and the overwhelming majority; the
 * rest are ordered by how often a deck wants them.
 */
export const VAR_KINDS = ["number", "vec2", "color", "boolean", "text", "font"];

/** The picker's labels. Sentence case, matching every other select in the app. */
export const VAR_KIND_LABELS = {
  number: "Number",
  vec2: "2-vector",
  color: "Color",
  boolean: "Boolean",
  text: "Text",
  font: "Font",
};

/**
 * The value a NEWLY DECLARED variable of each kind starts at — its zero.
 *
 * EVERY ONE IS A LEGAL VALUE OF ITS KIND, never null or "", because a variable is
 * created ALREADY KEYFRAMED on the current slide (the panel's standing rule) and a
 * keyframe holding a value its own control cannot display is a slot that reads as
 * broken the moment it is made. A colour variable born at "#ffffff" shows a white
 * swatch; born at null it would show a picker with nothing in it.
 *
 * The font zero is `DEFAULT_FONT` — the registry's OWN default id ("system", the
 * OS stack every un-styled text widget already uses), taken from
 * render_gpu/fonts.js rather than restated, so a new font variable starts on the
 * same face the app itself starts on and the two cannot drift apart.
 */
export const VAR_KIND_ZEROS = {
  number: 0,
  // A PLAIN TUPLE, carrying no runtime tag. `makeVector`'s `__vec` wrapper is
  // added by the evaluator on READ and must never reach a saved document
  // (pinned in tests/vec_values_test.js); a zero that carried one would put the
  // tag into every new variable's first keyframe.
  vec2: [0, 0],
  color: "#ffffff",
  boolean: false,
  text: "",
  font: DEFAULT_FONT,
};

/**
 * WHAT EACH KIND IS FOR, and — where there is one — the boundary a user would
 * otherwise discover by being confused. Shown in the picker's tooltip.
 *
 * The font note is the one the user's question earns: a font variable is a real
 * thing, and it does NOT make text follow it by itself.
 */
export const VAR_KIND_NOTES = {
  number: "A plain number — the default, and what every variable was before kinds existed. Scrub it, type it, or bind it to an equation.",
  vec2: "A 2-vector — an [x, y] pair edited as two boxes plus a drag pad. Read it whole (= origin) or by component (= origin.x), and compose it with vector algebra: a widget bound to = origin + offset moves when either does.",
  color: "A colour, edited with the swatch picker. Bind a widget's fill to it (= brandColor) to recolour a whole deck from one row.",
  boolean: "True or false. Useful driven through an equation — a widget's Visible row bound to = showNotes turns a whole layer on and off.",
  text: "A string. Bind a text widget's content to it (= caption) to write one line once and show it on many slides.",
  font: "A typeface from the registered roster. A widget does NOT follow it automatically — bind its Font row to the variable (= titleFont), the same way every other property is bound.",
};

/**
 * THE `vec2` KIND SHIPPED (workstream VECUI_), and the omission it replaces is
 * kept here rather than deleted, because the REASON it waited is the rule.
 *
 * WHAT THIS FILE USED TO SAY: there was no vec2 kind because there was no vec2
 * CONTROL. The evaluator half had worked since the value layer — a variable
 * holding an `[x, y]` tuple reads as a vector, enters the algebra and projects
 * with `.x`/`.y` (core/expressions.js refValue) — but declaring a kind whose
 * control does not exist would have put a variable in the panel that the panel
 * cannot edit: the "control that lies about its own affordance" failure this
 * codebase ruled against for the save dot. So the kind waited, and the omission
 * was recorded as an ASSERTION so it stayed visible.
 *
 * WHAT UNBLOCKED IT: `VEC2_ROW_KIND` (core/vector_values.js) — a real ROW_KINDS
 * entry whose control is Vector2Pad over a SINGLE slot holding the tuple. The
 * old note correctly diagnosed why the R7-36 compound row could not serve: a
 * compound is GROUPING over two leaf rows the widget already declares, and a
 * variable has no leaves to group. The answer was a control whose value IS the
 * tuple, not a grouping over parts of one.
 *
 * So the invariant `tests/compound_props_test.js` pins — every VAR_KINDS member
 * names a real ROW_KINDS control — is satisfied the ordinary way, by building
 * the control, rather than by relaxing the rule. That is what the omission was
 * protecting, and it is still protecting it for the next kind.
 */

/**
 * Pure function. A variable's declared kind — "number" when it has none, which is
 * every variable written before kinds existed and every one the author never
 * retyped.
 *
 * TOLERANT OF A DAMAGED MAP BY DESIGN: an entry naming a kind this build does not
 * know (a downgrade, a hand-edited file) reads as "number" rather than throwing,
 * because the VALUE is still there and still editable as what it literally is.
 * The LOUD half of that case belongs to `repairedDocument`, which reports and
 * drops the bad entry on load — a reader that also threw would take the app down
 * before the repair could say why.
 *
 * Args:
 *   varKinds (object|undefined): doc.meta.varKinds
 *   name (string): the variable's name
 *
 * Returns:
 *   string: a VAR_KINDS member
 *
 * Examples:
 *     >>> varKind({speed: "color"}, "speed")
 *     'color'
 *     >>> varKind({}, "speed")
 *     'number'
 *     >>> varKind(undefined, "speed")
 *     'number'
 *     >>> // an unknown kind degrades to number rather than throwing
 *     >>> varKind({speed: "quaternion"}, "speed")
 *     'number'
 */
export function varKind(varKinds, name) {
  const declared = varKinds?.[name];
  return VAR_KINDS.includes(declared) ? declared : "number";
}

/**
 * Pure function. The `meta.varKinds` map with one variable's kind set — or with
 * its entry REMOVED when the kind is the default.
 *
 * REMOVING RATHER THAN STORING "number" is what keeps a saved file honest: a map
 * full of `{x: "number"}` entries would appear as a diff in every document that
 * ever opened this panel while describing no change at all, and it would make an
 * absent entry and a present-but-default entry two spellings of one fact.
 *
 * Args:
 *   varKinds (object|undefined): the current map
 *   name (string): the variable's name
 *   kind (string): a VAR_KINDS member
 *
 * Returns:
 *   object: the new map (the input is never mutated)
 *
 * Examples:
 *     >>> withVarKind({}, "brand", "color")
 *     { brand: 'color' }
 *     >>> withVarKind({brand: "color"}, "brand", "number")
 *     {}
 *     >>> // other entries are untouched
 *     >>> withVarKind({a: "color"}, "b", "text")
 *     { a: 'color', b: 'text' }
 */
export function withVarKind(varKinds, name, kind) {
  const out = { ...(varKinds ?? {}) };
  if (kind === "number") delete out[name];
  else out[name] = kind;
  return out;
}

/**
 * Pure function. The map with a variable's entry dropped and, optionally, carried
 * to a new name — the two bookkeeping moves the panel's Delete and Rename owe it.
 *
 * WITHOUT THIS A RENAME SILENTLY RETYPES THE VARIABLE. `withVariableRenamed`
 * rewrites the value's path and every equation referencing it, but the kind map is
 * keyed by NAME, so the old key would be orphaned and the new name would read as
 * "number" — a colour variable that turned into a number because it was renamed.
 * Deleting has the mirror problem: a stale entry would retype the NEXT variable
 * that happened to reuse the name.
 *
 * Args:
 *   varKinds (object|undefined): the current map
 *   name (string): the variable being renamed or deleted
 *   newName (string|null): the new name, or null to delete
 *
 * Returns:
 *   object: the new map
 *
 * Examples:
 *     >>> withVarKindRenamed({brand: "color"}, "brand", "accent")
 *     { accent: 'color' }
 *     >>> withVarKindRenamed({brand: "color"}, "brand", null)
 *     {}
 *     >>> // a plain-number variable has no entry, so both moves are no-ops
 *     >>> withVarKindRenamed({a: "color"}, "speed", "rate")
 *     { a: 'color' }
 */
export function withVarKindRenamed(varKinds, name, newName) {
  const out = { ...(varKinds ?? {}) };
  const kind = out[name];
  delete out[name];
  if (newName != null && kind !== undefined) out[newName] = kind;
  return out;
}

/**
 * Pure function. The repair a loaded `meta.varKinds` needs: the cleaned map plus
 * the entries that were DROPPED and why, for repairedDocument to report LOUDLY.
 *
 * TWO FAILURES, BOTH DESTRUCTIVE AND THEREFORE BOTH LOUD (the meta.script rule):
 * a map that is not an object at all, and an entry naming a kind this build does
 * not have. Each drop changes how a variable is EDITED, so it can never be
 * silent — but note that neither drop touches the variable's VALUE, which is why
 * the report can honestly say the data survived.
 *
 * ABSENT IS NOT A FAILURE and produces no report: every document written before
 * kinds existed has no map, and an empty map means exactly what no map meant.
 *
 * Args:
 *   varKinds (*): whatever the document holds at meta.varKinds
 *
 * Returns:
 *   {varKinds: object, dropped: Array<{name: string, kind: *, reason: string}>}
 *
 * Examples:
 *     >>> repairedVarKinds(undefined)
 *     { varKinds: {}, dropped: [] }
 *     >>> repairedVarKinds({brand: "color"})
 *     { varKinds: { brand: 'color' }, dropped: [] }
 *     >>> // an unknown kind is dropped, and SAYS SO
 *     >>> repairedVarKinds({brand: "quaternion"}).dropped[0].reason
 *     'not one of number, color, boolean, text, font'
 *     >>> // a map that is not an object is discarded whole
 *     >>> repairedVarKinds("nonsense").varKinds
 *     {}
 */
export function repairedVarKinds(varKinds) {
  const dropped = [];
  if (varKinds == null) return { varKinds: {}, dropped };
  if (typeof varKinds !== "object" || Array.isArray(varKinds)) {
    dropped.push({ name: null, kind: varKinds, reason: `meta.varKinds was ${Array.isArray(varKinds) ? "an array" : typeof varKinds}, not an object of {name: kind}` });
    return { varKinds: {}, dropped };
  }
  const out = {};
  for (const [name, kind] of Object.entries(varKinds)) {
    if (VAR_KINDS.includes(kind)) out[name] = kind;
    else dropped.push({ name, kind, reason: `not one of ${VAR_KINDS.join(", ")}` });
  }
  return { varKinds: out, dropped };
}
