/**
 * THE shortcut entry set — every keyboard/pointer input the editor offers, and
 * the context predicates that decide when each is live.
 *
 * WHY THIS FILE EXISTS (and why it is not in App.svelte any more). The manifest
 * invariant is that the shortcut registry is the SINGLE source of truth for
 * inputs: it BOTH dispatches keydowns AND feeds the HintBar, so a shortcut that
 * isn't registered does not exist. That invariant is only as good as its guards,
 * and while the entries lived inline in a `.svelte` file NO node test could see
 * them — the only enforcement was a console.error at boot, which nothing reads.
 * Every guard in tests/shortcut_registry_test.js is possible because the entries
 * are importable from bare node. That is the whole reason for the move.
 *
 * The defect that motivated it: multi-selection resize reads Shift (uniform) and
 * Cmd (symmetric) and WORKS, but no chip ever appeared, because the modifier
 * hints were hand-scoped to `dragKind === "resize"` while CanvasView sets
 * "multiresize" — and the boot-time reachability prober walked a HAND-MAINTAINED
 * list of drag kinds that also omitted "multiresize", so it was structurally
 * blind to exactly this. Both lists are now DERIVED from ONE frozen table
 * (web/canvas/dragKinds.js DRAG_KIND_MODIFIERS), injected here: a new drag kind
 * cannot exist without being probed, and cannot declare a modifier without
 * getting a chip.
 *
 * DOM-free (core/ must run in bare node; tests enforce this). Everything that
 * touches the browser stays in App.svelte: creating the keybinding registry from
 * KEYBINDING_DEFAULTS (localStorage overrides), classifying the focused element
 * into the context axes, and the $derived that feeds the bar.
 *
 * ── THE CONTEXT AXES ────────────────────────────────────────────────────────
 * A `when` predicate reads a plain context object (App.svelte's shortcutCtx()):
 *   mode                 "edit" | "present"
 *   paletteOpen          the command palette owns the keyboard
 *   hasSelection         at least one item is selected
 *   dragging / dragKind  a live pointer gesture and WHICH kind (DRAG_KINDS)
 *   crosshairArmed       an armed one-shot crosshair skin ("band" | "place") or null
 *   canvasMode           a widget canvas mode's handler id, or null
 *   canvasModeStep       which STEP of a multi-step creation mode is current (an
 *                        index into the mode's declared `steps`; 0 for a mode with
 *                        no sequence). This is what lets the bar NARRATE a
 *                        multi-gesture placement — "drag the region to magnify",
 *                        then "now drag where the magnified view goes" — instead of
 *                        showing one averaged chip for a flow that changes meaning
 *                        halfway through.
 *   activation           the ACTIVATE handler id (web/widget_handlers.js) the
 *                        SELECTED widget declares, or null — what a DOUBLE-CLICK
 *                        on it would do. The axis exists because double-click was
 *                        the app's one wholly undiscoverable input: seven distinct
 *                        behaviours, all delivered by a DOM `dblclick`, none of
 *                        them ever on the bar. The user reported it on the case
 *                        with no other affordance at all — "double clicking adds a
 *                        new point but the shortcut area didnt mention that".
 *   modalActive          a live G/S modal transform locks input (Blender modal)
 *   snapEngaged          the live drag has an active snap correction
 *   textEditing / textEditingRich / latexEditing / codeEditing   in-place editors
 *   typingTarget         the focused element owns keystrokes (input/textarea/
 *                        select/contenteditable/math-field)
 *   dialogOpen           a modal DIALOG (lib/Modal.svelte) owns the screen
 *   numericField         a focused numeric field: "scrubber" (DraggableNumber) |
 *                        "dial" (AngleField) | null
 *   numericFieldBounded  that field has both a min and a max (so Home/End apply)
 */

// NOTHING from web/ is imported here. core/ is the DOM-free foundation, so the
// drag-kind vocabulary (web/canvas/dragKinds.js) and the widget-handler registry
// (web/widget_handlers.js) are INJECTED by the caller rather than imported —
// otherwise this module would reach up into web/ and invert the layering. The one
// import is a core SIBLING: the double-click token, taken from the registry that
// defines the vocabulary rather than re-spelled here, so there is exactly one
// spelling of it across core, the plugins that declare it, and the icon map.
import { MOUSE_DOUBLE_TOKEN } from "./shortcuts.js";

// ── THE PREDICATE BASE, AND WHY IT EXISTS ───────────────────────────────────
// Three rungs, each excluding exactly one class of takeover:
//   editorInput — the registry can dispatch AT ALL. Excludes present mode, a
//     focused typing target, and an open dialog: three things that swallow the
//     keystroke before the registry ever sees it. Keeping these HERE is what makes
//     the bar honest, because the same predicate decides "does the chip show" and
//     "does the key fire". Anything with a `run`/`command` MUST descend from it.
//   editBase / modalTransform — the two halves of "who owns the keys inside the
//     editor": ordinary input, or a live G/S modal transform (Blender's modal
//     lock). Complementary by construction, so they can never both announce.
//   editMode — ordinary input with no ONE-SHOT/mode takeover (an armed crosshair,
//     a widget canvas mode, an open palette). Those three live in editMode ALONE;
//     every context that wants to be live DURING one composes editBase, never
//     editMode.
//
// THIS IS A STRUCTURAL FIX, NOT A STYLE CHOICE. Two hints once read
// `editMode(c) && c.crosshairArmed === "band"` — unsatisfiable, because editMode
// requires `!c.crosshairArmed`, so they could never render and never did. Any
// predicate of the form "editMode AND (something editMode excludes)" is dead code
// that looks alive. Two things now make that class of bug impossible:
//   1. the exclusions exist once, and takeover-scoped predicates are BUILT by the
//      factories below (armed / inCanvasMode) rather than hand-&&-ed onto
//      editMode, so the contradiction has nowhere to form; and
//   2. unsatisfiableEntries() proves every registered entry can fire in at least
//      one reachable app context — a THROWING node test (and a loud console.error
//      tripwire at boot), so a future contradiction fails at the gate instead of
//      silently shipping an invisible shortcut.
/**
 * Pure function. The registry can dispatch AT ALL: edit mode, and no other
 * component holding the keyboard. Both exclusions mirror an unconditional early
 * return in App.svelte's onKeydown / a window listener that claims keys first, so
 * an entry with a `run` or `command` that is live here but not there is a chip the
 * app cannot honour. THE root of every editor predicate, including the modal
 * transform's — which is why it is separate from editBase.
 *
 * @example editorInput({mode: "edit"}) // true
 * @example editorInput({mode: "edit", typingTarget: true}) // false — the focused field owns keys
 * @example editorInput({mode: "present"}) // false — PresentMode owns its keys
 * @example editorInput({mode: "edit", paletteOpen: true}) // false — the palette owns its keys
 */
export const editorInput = (c) => c.mode === "edit" && !c.typingTarget && !c.dialogOpen && !c.paletteOpen;
/** Pure function. The editor is accepting ORDINARY input: dispatchable, and no
 * live G/S modal transform locking input Blender-style.
 * @example editBase({mode: "edit"}) // true
 * @example editBase({mode: "edit", modalActive: true}) // false — the modal owns keys */
export const editBase = (c) => editorInput(c) && !c.modalActive;
/** Pure function. A live G/S modal transform's OWN inputs. The complement of
 * editBase inside editorInput: exactly one of the two is true whenever the editor
 * can dispatch, so the modal's keys and the ordinary keys can never both show.
 * @example modalTransform({mode: "edit", modalActive: true}) // true
 * @example modalTransform({mode: "edit", modalActive: true, typingTarget: true}) // false */
export const modalTransform = (c) => editorInput(c) && c.modalActive;
/** Pure function. Ordinary editor input: editBase, and no one-shot/mode takeover.
 * @example editMode({mode: "edit"}) // true
 * @example editMode({mode: "edit", paletteOpen: true}) // false */
export const editMode = (c) => editBase(c) && !c.crosshairArmed && !c.canvasMode;
/**
 * Pure function. editMode with something selected, and NO handle selection.
 *
 * THE TWO SELECTION SCOPES (see web/app.svelte.js handleSelection for the full
 * statement): an item selection is the OUTER scope, a set of the selected widget's
 * MODIFIER POINTS is the INNER one, and the INNER SCOPE WINS A CONTESTED KEY.
 * Excluding `handlesSelected` here is what implements that for every item-scoped
 * entry at once — Backspace hides the selected POINTS rather than the item, and
 * Escape clears the points rather than deselecting — without any ordering trick,
 * and therefore with exactly ONE chip per key on the HintBar. It is the same
 * disambiguation-by-`when` construction `deselectable` uses for a live point drag.
 *
 * @example editSelection({mode: "edit", hasSelection: true}) // true
 * @example editSelection({mode: "edit"}) // undefined (FALSY, not false: `&&` yields the absent flag itself, which is all a `when` gate reads)
 * @example editSelection({mode: "edit", hasSelection: true, handlesSelected: true}) // false — the inner scope owns the keys
 */
export const editSelection = (c) => editMode(c) && c.hasSelection && !c.handlesSelected;
/**
 * Pure function. HANDLES are selected — the inner selection scope owns the keys
 * that both scopes want. Requires `hasSelection` because handles only exist for a
 * selected item (CanvasView draws them for a single selection only), so the two
 * flags always travel together; stating it keeps the predicate right on its own
 * terms rather than right by luck.
 *
 * @example handlesSelected({mode: "edit", hasSelection: true, handlesSelected: true}) // true
 * @example handlesSelected({mode: "edit", hasSelection: true}) // false
 * @example handlesSelected({mode: "edit", handlesSelected: true}) // undefined (FALSY — no item, so no handles; same `&&` shape as editSelection)
 */
export const handlesSelected = (c) => editMode(c) && c.hasSelection && !!c.handlesSelected;
/**
 * The drag kinds whose ESCAPE is claimed by CanvasView, which cancels the gesture
 * from a CAPTURE-phase listener so the selection survives — it MUST pre-empt App's
 * bubble-phase Deselect, so for these kinds Escape means "cancel", never "deselect".
 *
 * Two entries read this list, and they are the two halves of one key having one
 * announced meaning: "Cancel drag" is shown for exactly these kinds, and
 * `deselectable` withholds the Deselect chip for them. Enumerated here rather than
 * per-entry because getting the two lists out of step is how the bar ends up going
 * quiet on a gesture Escape really does cancel (CanvasView's own comment at its
 * capture listener says exactly that).
 *
 * CanvasView IMPORTS this list rather than redeclaring it, so there is nothing to
 * drift: the capture-phase listener that cancels the gesture and the two entries
 * that announce it read the same array. It used to keep a local Set with a
 * scan-based drift guard over the two copies — a guard can only report a
 * divergence that already shipped, so one copy retires it. tests/
 * shortcut_registry_test.js now asserts the component holds no second copy.
 */
export const ESC_CANCELABLE_DRAG_KINDS = Object.freeze(["modifier", "endpoint"]);
/**
 * Pure function. editSelection, EXCEPT during a drag that owns Escape (see
 * ESC_CANCELABLE_DRAG_KINDS) — a "Deselect" chip there would be the bar's second
 * Escape chip in one context, only one of which fires. Same
 * disambiguation-by-`when` the crosshair and modal Escape entries use.
 *
 * @example deselectable({mode: "edit", hasSelection: true}) // true
 * @example deselectable({mode: "edit", hasSelection: true, dragKind: "modifier"}) // false
 * @example deselectable({mode: "edit", hasSelection: true, dragKind: "endpoint"}) // false
 */
export const deselectable = (c) => editSelection(c) && !ESC_CANCELABLE_DRAG_KINDS.includes(c.dragKind);
/**
 * Pure function. `handlesSelected`, EXCEPT during a point drag whose Escape
 * CanvasView claims — the handle-scope twin of `deselectable`, built the same way
 * for the same reason: while a handle drag is live, Escape CANCELS the drag (a
 * capture-phase listener), so offering "Deselect points" there would put a second
 * Escape chip on the bar that never fires.
 *
 * @example handleDeselectable({mode: "edit", hasSelection: true, handlesSelected: true}) // true
 * @example handleDeselectable({mode: "edit", hasSelection: true, handlesSelected: true, dragKind: "modifier"}) // false
 */
export const handleDeselectable = (c) => handlesSelected(c) && !ESC_CANCELABLE_DRAG_KINDS.includes(c.dragKind);
/**
 * Pure function. A DOUBLE-CLICK on the selected widget would run the activation
 * `handlerId` (web/widget_handlers.js ACTIVATE_HANDLERS).
 *
 * Composed from `editMode`, not `editSelection`, on purpose in both directions:
 *   - it must survive `handlesSelected`. The reported case IS a polygon with a
 *     modifier point selected: double-clicking its outline still inserts a point,
 *     so the editSelection exclusion that hands Backspace to the inner scope would
 *     hide this chip exactly when the user is working on the points. Double-click
 *     is not a contested key — no other reading of it exists at either scope.
 *   - `editMode`'s own exclusions are the ones CanvasView's onDblClick states as
 *     early returns (a live drag, a modal transform, a widget canvas mode), plus an
 *     armed crosshair, where the bar narrates the placement gesture instead and the
 *     mode/crosshair owns the pointer. `!c.dragging` mirrors the `drag` guard
 *     directly, exactly as the "Select / drag" entry does.
 * `hasSelection` is required rather than assumed: the axis is RESOLVED from the
 * selected item's plugin, so the two always travel together — stating it keeps the
 * predicate right on its own terms rather than right by luck (`handlesSelected`'s
 * precedent).
 *
 * KNOWN BOUND, deliberately accepted. The gesture resolves against the widget under
 * the POINTER; the chip is scoped to the SELECTED one. So double-clicking an
 * unselected widget still activates it with nothing announced. Hover is the only
 * axis that would close that, and it is the wrong trade: there is no widget-hover
 * state in the app, the bar would re-derive on every mousemove, and it would be the
 * one hover-scoped chip among ~90 selection- and gesture-scoped ones. Selection
 * also matches how the gesture is actually reached — you click a widget to find out
 * what it is, so the chip appears one gesture BEFORE it is wanted.
 *
 * @example // activatable("insert_point")({mode: "edit", hasSelection: true, activation: "insert_point"}) → true
 * @example // activatable("insert_point")({mode: "edit", hasSelection: true, activation: "latex_edit"}) → false
 * @example // activatable("insert_point")({mode: "edit", hasSelection: true, handlesSelected: true, activation: "insert_point"}) → true
 * @example // activatable("insert_point")({mode: "edit", hasSelection: true, activation: "insert_point", dragging: true}) → false
 */
export const activatable = (handlerId) => (c) => editMode(c) && c.hasSelection && !c.dragging && c.activation === handlerId;
/** Pure function. ANY crosshair skin is armed — the skin-agnostic half of `armed`,
 * used by the one entry (Escape → cancel) that means the same thing for every skin.
 * `!c.canvasMode`: a widget canvas mode OUTRANKS an armed crosshair, because
 * CanvasView.onPointerDown gives the mode the pointer first (modePointerDown returns
 * before the crosshair branch) and entering a mode does not clear the arm — so
 * announcing the crosshair's gesture there would name a click the mode consumes.
 * @example armedAny({mode: "edit", crosshairArmed: "place"}) // true
 * @example armedAny({mode: "edit", crosshairArmed: "place", canvasMode: "navigate_interior"}) // false
 * @example armedAny({mode: "edit", crosshairArmed: "place", typingTarget: true}) // false */
export const armedAny = (c) => editBase(c) && !c.canvasMode && !!c.crosshairArmed;
/** Pure function. A context predicate scoped to an ARMED crosshair skin —
 * composed from editBase, so it is satisfiable by construction.
 * @example // armed("band")({mode: "edit", crosshairArmed: "band"}) → true */
export const armed = (skin) => (c) => armedAny(c) && c.crosshairArmed === skin;
/** Pure function. A band-select GESTURE context — armed OR mid-drag. The band's
 * modifier verbs must be announced through both halves of the gesture: while
 * ARMED (crosshairArmed === "band", before the drag starts) and while DRAGGING
 * (dragKind === "band", after the one-shot arm is consumed). Composed from
 * editBase for the same reason `armed` is: `editMode` excludes an armed
 * crosshair, so anything ANDed onto it would be dead exactly when it is needed.
 * @example // bandGesture({mode: "edit", crosshairArmed: "band"}) → true
 * @example // bandGesture({mode: "edit", dragKind: "band"}) → true */
export const bandGesture = (c) => editBase(c) && !c.canvasMode && (c.dragKind === "band" || c.crosshairArmed === "band");
/** Pure function. A context predicate scoped to a live WIDGET CANVAS MODE
 * (web/widget_handlers.js) — same construction, same guarantee.
 * @example // inCanvasMode("navigate_interior")({mode: "edit", canvasMode: "navigate_interior"}) → true */
export const inCanvasMode = (handlerId) => (c) => editBase(c) && c.canvasMode === handlerId;
/**
 * Pure function. A context predicate scoped to ONE STEP of a multi-step creation
 * mode. Built on `inCanvasMode` (and so on editBase), so it is satisfiable by
 * construction; the step axis is what keeps two steps' chips from ever showing at
 * once, which the "one key, one meaning" guard would otherwise fail on — two "box"
 * steps both announce mouse_left, with different words.
 *
 * @example // inCanvasStep("telescopic_rig", 1)({mode: "edit", canvasMode: "telescopic_rig", canvasModeStep: 1}) → true
 * @example // inCanvasStep("telescopic_rig", 1)({mode: "edit", canvasMode: "telescopic_rig", canvasModeStep: 0}) → false
 */
export const inCanvasStep = (handlerId, step) => (c) => inCanvasMode(handlerId)(c) && c.canvasModeStep === step;
/** Pure function. Fullscreen presentation mode.
 * @example presentMode({mode: "present"}) // true */
export const presentMode = (c) => c.mode === "present";
/**
 * Pure function. The command palette owns the keyboard.
 *
 * `mode === "edit"` because present mode is the OTHER keyboard takeover, and both
 * bind Escape to different verbs — a bar showing "Exit" and "Back / close" on one
 * key is exactly the lie this scoping prevents. The two cannot actually co-occur
 * (the palette sets paletteOpen = false BEFORE running any command, so entering
 * present mode from it closes it first, and toggle-palette is editMode-scoped so it
 * cannot be opened from the presenter), but the predicate says so rather than
 * relying on that.
 *
 * @example paletteContext({mode: "edit", paletteOpen: true}) // true
 * @example paletteContext({mode: "present", paletteOpen: true}) // false
 */
export const paletteContext = (c) => c.mode === "edit" && c.paletteOpen;
// ── THE IN-PLACE EDITORS ────────────────────────────────────────────────────
// Each owns the keyboard while it is open, and each is a TYPING TARGET, so the
// registry cannot dispatch its keys — the entries scoped by these predicates are
// display-only and the owning controller acts. All four require mode === "edit"
// for one concrete reason: enterPresentMode() calls dismissEdit() before flipping
// the mode, so an in-place edit and the presenter can never be live together, and
// without the guard the bar would offer Escape as both "Done editing" and "Exit".
/** Pure function. A text box is being edited in place (plain OR rich).
 * @example textEdit({mode: "edit", textEditing: true}) // true */
export const textEdit = (c) => c.mode === "edit" && !!c.textEditing;
/** Pure function. A RICH text box is being edited in place — the formatting
 * shortcuts have no meaning for a plaintext boxs plain string.
 * @example richTextEdit({mode: "edit", textEditingRich: true}) // true */
export const richTextEdit = (c) => c.mode === "edit" && !!c.textEditingRich;
/** Pure function. A MathLive latex field is open.
 * @example latexEdit({mode: "edit", latexEditing: true}) // true */
export const latexEdit = (c) => c.mode === "edit" && !!c.latexEditing;
/** Pure function. The multi-line code editor panel is open.
 * @example codeEdit({mode: "edit", codeEditing: true}) // true */
export const codeEdit = (c) => c.mode === "edit" && !!c.codeEditing;
/** Pure function. An ORDINARY drag gesture of one kind is live.
 * @example // duringDrag("resize")({mode: "edit", dragKind: "resize"}) → true */
export const duringDrag = (kind) => (c) => editMode(c) && c.dragKind === kind;
/**
 * Pure function. A focused numeric field of `kind` OWNS the modifier keys, because
 * nothing on the canvas is mid-gesture or armed to claim them instead.
 *
 * Deliberately NOT composed from editMode, in both directions:
 *   - it must survive `dialogOpen` — ExportMp4Modal's width/height/fps/CRF ARE
 *     DraggableNumbers inside a dialog, fully live, and editMode excludes dialogs;
 *   - it must NOT survive a live drag, an armed crosshair, a widget canvas mode or
 *     a modal transform, because Shift cannot mean "finer field step" AND "uniform
 *     scale" on one bar, and the takeover is the more specific thing the user is
 *     doing, so it wins.
 *
 * WHY THE EXCLUSIONS CARRY LOAD, in the two shapes they come in — this used to be
 * justified by "clicking a resize handle does not blur the Inspector, so a field
 * can hold focus through a canvas gesture", which tests/field_key_ownership_probe.js
 * MEASURED FALSE: both a resize drag and a move drag move focus off the field onto
 * the canvas's PanZoom container (`div[role=application]`, tabindex="-1"), so
 * `numericField` is already null by the time `dragging` is true.
 *   - `!c.crosshairArmed` / `!c.canvasMode` are the REACHABLE ones, and nothing
 *     else covers them: those takeovers are entered by a COMMAND, not by a canvas
 *     gesture, so nothing blurs the Inspector and the one-shot arm outlives the
 *     click that focuses a field. The probe measures the coexistence directly (an
 *     armed band crosshair with a focused spinbutton), and it is a real collision,
 *     not a hypothetical: `bandGesture` composes editBase, which a focused
 *     spinbutton passes (it is no typing target), so Shift would be announced twice
 *     — "Remove from selection" and "Fine adjust" — on one bar.
 *   - `!c.dragging` / `!c.modalActive` are the BY-CONSTRUCTION ones. A drag cannot
 *     currently coexist with a focused field, but that is a fact about PanZoom's
 *     markup being focusable, i.e. about another component: drop its tabindex and
 *     the field would keep focus through the gesture, with Shift colliding against
 *     DRAG_MODIFIER_HINTS. The exclusion states the precedence here so the
 *     predicate is right on its own terms rather than right by luck.
 *
 * @example // fieldFocus("scrubber")({mode: "edit", numericField: "scrubber"}) → true
 * @example // fieldFocus("scrubber")({mode: "edit", numericField: "scrubber", dragging: true}) → false
 * @example // fieldFocus("scrubber")({mode: "edit", numericField: "scrubber", dialogOpen: true}) → true
 */
export const fieldFocus = (kind) => (c) =>
  c.mode === "edit" && c.numericField === kind
  && !c.dragging && !c.crosshairArmed && !c.canvasMode && !c.modalActive;

/**
 * Command-bound key combos: the EDITOR-setting defaults (core/keybindings.js),
 * overridable per user. The bridge (toShortcutEntries) turns them into registry
 * entries, so EVERYTHING still routes through the command registry (the manifest
 * invariant) and the palette displays each command's keys automatically.
 * `when` names a resolver in WHEN_RESOLVERS.
 */
export const KEYBINDING_DEFAULTS = [
  { command: "toggle-palette", keys: ["Cmd", "Shift", "P"], when: "editMode" },
  { command: "undo", keys: ["Ctrl", "Z"], when: "editMode" },
  { command: "redo", keys: ["Ctrl", "Shift", "Z"], when: "editMode" },
  { command: "delete-item", keys: ["Backspace"], when: "editSelection" },
  // PURGE = "delete and remove from existence" (the user's vocabulary): plain
  // Backspace/Delete only DEACTIVATES the item on this slide (it stays in the
  // document, on other slides, keyframable back); the MODIFIED key removes it
  // from existence — every keyframe, every slide. Same key, harder gesture,
  // strictly bigger consequence, which is exactly the relationship the two words
  // describe. `Cmd` covers Control too (core/shortcuts.js dispatch matches
  // `mods.includes("cmd") || mods.includes("ctrl")` against `metaKey||ctrlKey`),
  // so ONE entry is platform-agnostic; the Delete-key alias rides the hand
  // entries below, because core/keybindings.js is one binding per command by
  // design. No collision: comboEquals is exact, so ["Cmd","Backspace"] and
  // ["Backspace"] are different combos, and dispatch requires the modifier state
  // to MATCH (delete-item declares no modifier, so a held Cmd excludes it — the
  // two can never both fire). Purge is ONE undo unit (purgeSelection → commit),
  // so one Ctrl+Z brings the item back with every keyframe intact; no confirm
  // dialog is warranted for an undoable action, and one on every purge would be
  // worse.
  { command: "purge-item", keys: ["Cmd", "Backspace"], when: "editSelection" },
  { command: "copy-item", keys: ["Ctrl", "C"], when: "editSelection" },
  { command: "paste", keys: ["Ctrl", "V"], when: "editMode" },
  // 14.9: Cmd/Ctrl+D = Duplicate. FLAGGED — the binding is the convention
  // candidate PENDING USER RATIFICATION (Cmd+D is the browser bookmark key;
  // onKeydown preventDefaults on dispatch so the bookmark is suppressed while
  // editing). No existing binding uses D, so createKeybindings finds no
  // conflict (keybindings_test guards this).
  { command: "duplicate", keys: ["Cmd", "D"], when: "editSelection" },
  { command: "put-on-top", keys: ["Cmd", "Shift", "F"], when: "editSelection" },
  { command: "put-on-bottom", keys: ["Cmd", "Shift", "B"], when: "editSelection" },
  { command: "prev-slide", keys: ["Left"], when: "editMode" },
  { command: "next-slide", keys: ["Right"], when: "editMode" },
  // P = present (fullscreen), the PowerPoint-parity "play" key. editMode
  // (not editSelection) so it fires whenever the canvas has focus, selection
  // or not; editBase's typing-target exclusion keeps a literal "p" in a text
  // field from ever reaching the registry.
  { command: "present", keys: ["P"], when: "editMode" },
  // B = box select (user request). editMode, NOT editSelection: you box-select
  // in order to CREATE a selection, so requiring one first would make the key
  // dead exactly when it is wanted — the same reasoning P above documents for
  // itself. It arms `band-select-regular`, the "plain box select" entry point
  // the toolbar button already uses, so all three surfaces (key, toolbar,
  // palette) resolve the mode identically (the default bandMode setting).
  // No collision: the only other B binding is put-on-bottom's Cmd+Shift+B, a
  // different combo (comboEquals is exact), and createKeybindings throws on a
  // real conflict rather than letting one shadow the other silently.
  { command: "band-select-regular", keys: ["B"], when: "editMode" },
  { command: "deselect", keys: ["Escape"], when: "deselectable" },
  // THE HANDLE SCOPE REUSES THE ITEM SCOPE'S KEYS, one level down — the SAME
  // Backspace-hides / Cmd+Backspace-purges relationship, applied to the selected
  // MODIFIER POINTS instead of the selected items. This is the whole reason the two
  // scopes are one idea: the harder gesture has the strictly bigger consequence,
  // and the words mean the same thing at both levels (hide keyframes visibility off
  // and renumbers nothing; purge removes for good and renumbers what follows).
  // No collision with the item entries: `editSelection` now EXCLUDES a live handle
  // selection and `handlesSelected` requires one, so the two are complementary by
  // construction and exactly one of each pair is ever live.
  { command: "hide-points", keys: ["Backspace"], when: "handlesSelected" },
  { command: "purge-points", keys: ["Cmd", "Backspace"], when: "handlesSelected" },
];

/** HintBar labels for the command-bound keys above (toShortcutEntries throws on
 * a missing one, so this map cannot drift out of KEYBINDING_DEFAULTS). */
export const KEYBINDING_LABELS = {
  "toggle-palette": "Palette", undo: "Undo", redo: "Redo",
  "delete-item": "Delete", "copy-item": "Copy", paste: "Paste",
  duplicate: "Duplicate",
  "purge-item": "Purge",
  "put-on-top": "To front", "put-on-bottom": "To back",
  "prev-slide": "Prev slide", "next-slide": "Next slide", present: "Present",
  "band-select-regular": "Box select",
  deselect: "Deselect",
  "hide-points": "Hide points", "purge-points": "Purge points",
};

/** The `when`-name → predicate map the keybinding bridge resolves against. */
export const WHEN_RESOLVERS = { editMode, editSelection, deselectable, handlesSelected };

/**
 * The HELD-MODIFIER verbs a drag kind can read, keyed by the semantic modifier id
 * web/canvas/dragKinds.js DRAG_KIND_MODIFIERS uses. THE single place a drag
 * modifier's key and wording are written; the entries are GENERATED from that
 * table, so a kind that declares a modifier gets a chip automatically and a kind
 * that does not declare one cannot accidentally advertise it.
 *
 * All display-only: the pointer code reads the raw modifier flags itself
 * (CanvasView resizeDrag/multiResizeDrag/placementDrag/moveDrag/band verbs).
 */
export const DRAG_MODIFIER_HINTS = Object.freeze({
  axisLock: { keys: ["Shift"], label: "Axis lock" },
  uniform: { keys: ["Shift"], label: "Uniform scale" },
  symmetric: { keys: ["Cmd"], label: "Symmetric resize" },
  bandAdd: { keys: ["Cmd"], label: "Add to selection" },
  bandRemove: { keys: ["Shift"], label: "Remove from selection" },
  bandInvert: { keys: ["Alt"], label: "Invert in box" },
});

/**
 * Pure function. The context predicate a drag kind's modifier hints run under.
 * "band" is the one kind whose verbs must be announced BEFORE the drag starts —
 * you need to know them while the crosshair is ARMED, which is when you decide
 * which modifier to hold — so it gets bandGesture (armed OR mid-drag); every
 * other kind only exists mid-drag.
 *
 * @example // dragModifierContext("band") === bandGesture
 * @example // dragModifierContext("resize")({mode: "edit", dragKind: "resize"}) → true
 */
export function dragModifierContext(kind) {
  return kind === "band" ? bandGesture : duringDrag(kind);
}

/**
 * Query (reads `app` methods into closures; otherwise pure). Every HAND-registered
 * entry: hidden key aliases, display-only pointer/modifier hints, the modal
 * transform's own keys, and the inputs OTHER components dispatch but the registry
 * must still know about (present mode, the in-place editors, the palette, a
 * focused numeric field).
 *
 * "Registered but externally dispatched" is a first-class case, not a hack — see
 * core/shortcuts.js: "gestures handled by pointer code still REGISTER here for
 * the HintBar". Such an entry has neither `command` nor `run`; the owning
 * component keeps the dispatch, and the registry keeps the KNOWLEDGE. That is
 * what makes "a shortcut that isn't registered does not exist" enforceable
 * instead of aspirational.
 *
 * Args:
 *   app                — the app instance the live entries drive (run closures)
 *   canvasModes        — web/widget_handlers.canvasModes() output
 *   dragKindModifiers  — web/canvas/dragKinds.js DRAG_KIND_MODIFIERS
 *   activations        — web/widget_handlers.activations() output
 *
 * Returns: the entry array, ready for shortcuts.add() in order.
 */
export function handShortcutEntries({ app, canvasModes, dragKindModifiers, activations }) {
  // Loud cross-check (house idiom: core/properties.js BLEND_MODES ↔ LABELS): a
  // drag kind declaring a modifier this module has no wording for would silently
  // announce nothing, which is the exact defect the table exists to prevent.
  for (const [kind, ids] of Object.entries(dragKindModifiers))
    for (const id of ids)
      if (!DRAG_MODIFIER_HINTS[id])
        throw new Error(`shortcut_entries: drag kind "${kind}" declares modifier "${id}" but DRAG_MODIFIER_HINTS has no keys/label for it — add one, or the modifier would work with no chip (the multiresize defect).`);
  // A CREATION-MODE STEP reads modifiers too (a "box" step runs the same
  // creationRect math a "place" drag does; a polygon vertex axis-locks against the
  // previous one), and it is the SAME table, checked the same way — a step that
  // named a modifier with no wording would be the multiresize defect wearing a
  // different hat.
  for (const { handlerId, steps } of canvasModes)
    steps.forEach((s, i) => {
      for (const id of s.modifiers ?? [])
        if (!DRAG_MODIFIER_HINTS[id])
          throw new Error(`shortcut_entries: creation mode "${handlerId}" step ${i} declares modifier "${id}" but DRAG_MODIFIER_HINTS has no keys/label for it.`);
    });
  const stepModifierIds = canvasModes.flatMap(({ steps }) => steps.flatMap((s) => s.modifiers ?? []));
  for (const id of Object.keys(DRAG_MODIFIER_HINTS))
    if (!Object.values(dragKindModifiers).some((ids) => ids.includes(id)) && !stepModifierIds.includes(id))
      throw new Error(`shortcut_entries: DRAG_MODIFIER_HINTS declares "${id}" but no drag kind in DRAG_KIND_MODIFIERS and no creation-mode step reads it — an entry no gesture can ever satisfy.`);
  // An ACTIVATION with no wording would put a BLANK chip on the bar — the whole
  // reason double-click could be registered without inventing vocabulary is that
  // every descriptor already carries a `label`, so a new one omitting it must fail
  // loudly here rather than ship an empty chip (the DRAG_MODIFIER_HINTS check's
  // twin, over the other table this file generates from).
  for (const { handlerId, label } of activations)
    if (!label)
      throw new Error(`shortcut_entries: activate handler "${handlerId}" declares no \`label\`, but the double-click HintBar entry is generated from it — the bar would show an empty chip. Give the descriptor in web/widget_handlers.js a label naming what double-clicking the widget DOES.`);
  // A mode's finalize GESTURE is delivered by CanvasView's dblclick handler and by
  // nothing else, so a mode declaring it on any other token would announce a
  // gesture the app never delivers — the mouse-shaped form of an unmatchable key
  // token, caught at the same place validateShortcutKeys catches those.
  for (const { handlerId, finishGesture } of canvasModes)
    if (finishGesture && (finishGesture.keys.length !== 1 || finishGesture.keys[0] !== MOUSE_DOUBLE_TOKEN))
      throw new Error(`shortcut_entries: creation mode "${handlerId}" declares finishGesture on ${JSON.stringify(finishGesture.keys)}, but the only gesture that finalizes a mode is the double-click CanvasView's dblclick handler delivers — declare ["${MOUSE_DOUBLE_TOKEN}"] or use \`finish\` for a KEY.`);

  return [
    { keys: ["Delete"], label: "Delete", hidden: true, when: editSelection, command: "delete-item" },
    // The Delete-key form of PURGE — the same alias treatment (and the same
    // hidden: true reasoning) as the Delete/Backspace pair above: the visible
    // Cmd+Backspace chip already teaches the word, so a second chip for the same
    // command would be clutter.
    { keys: ["Cmd", "Delete"], label: "Purge", hidden: true, when: editSelection, command: "purge-item" },
    // The HANDLE-SCOPE aliases and Escape, mirroring the item block above line for
    // line: the Delete-key faces are hidden aliases of the visible Backspace chips,
    // and Escape clears the INNER scope only — the item stays selected, because
    // clearing two selections with one key would destroy work you did not mean to.
    { keys: ["Delete"], label: "Hide points", hidden: true, when: handlesSelected, command: "hide-points" },
    { keys: ["Cmd", "Delete"], label: "Purge points", hidden: true, when: handlesSelected, command: "purge-points" },
    { keys: ["Escape"], label: "Deselect points", when: handleDeselectable, run: () => app.clearHandleSelection() },
    // SPACEBAR opens the palette (manifest Round 12B: Blender spacebar
    // precedent, same action as Cmd+Shift+P) — a second key ALIAS for
    // toggle-palette, hand-registered exactly like the Delete/Backspace alias
    // above (core/keybindings.js is ONE binding per command by design, for a
    // future keybinding-editor UI; a second alias to the same command is the
    // documented escape hatch). `editMode` matches Cmd+Shift+P's own `when`.
    // hidden:true — and here is the WHY, since the asymmetry with a VISIBLE
    // Paste chip is deliberate: Space is a pure ALIAS of a combo whose chip is
    // already on the bar (Cmd+Shift+P), so a second chip would teach nothing new;
    // Ctrl+V is not an alias of anything, so it IS shown. Alias ⇒ hidden, own
    // action ⇒ visible, everywhere in this file.
    { keys: ["Space"], label: "Palette", hidden: true, when: editMode, command: "toggle-palette" },
    { keys: ["mouse_left"], label: "Select / drag", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed },
    // Shift-click ADDS/REMOVES from the multi-selection (manifest "Shift-click
    // multi-select"). Display-only, same registry pathway as the other pointer
    // hints — the pick code reads the modifier itself. Alongside "Select / drag"
    // while idle over the canvas; hidden mid-drag (shift then means axis-lock,
    // whose own hint fires) and while a crosshair mode is armed.
    { keys: ["Shift", "mouse_left"], label: "Add to selection", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed },
    // An armed CROSSHAIR mode (manifest ARCHITECTURE PLAN #5) replaces the
    // plain pointer hint until the one-shot gesture happens — one hint per
    // skin (band-select vs placement), each named for what the drag DOES.
    // Composed from the `armed` factory, which is built on editBase and cannot
    // contradict itself (they once ANDed editMode and rendered never).
    { keys: ["mouse_left"], label: "Drag box to select", when: (c) => armed("band")(c) && !c.dragging },
    { keys: ["mouse_left"], label: "Click or drag to place", when: (c) => armed("place")(c) && !c.dragging },
    // Escape cancels an ARMED (not-yet-gesturing) crosshair mode — the editMode
    // exclusion (!c.crosshairArmed) means this is the ONLY live Escape handler
    // while armed, so no ordering trick is needed (same disambiguation-by-`when`
    // the modalActive Escape entry below uses).
    { keys: ["Escape"], label: "Cancel", when: armedAny, run: () => app.cancelCrosshair() },
    // ANCHOR SNAP (manifest ARCHITECTURE PLAN #4): while a move/resize drag
    // has an ACTIVE snap correction, announce the A-key equation-write. Held
    // A is read directly by CanvasView at pointer-up (a plain keydown/keyup
    // pair, not a command — nothing to run here; display-only, like the
    // Shift/Cmd resize-modifier hints). Only "move" and "resize": CanvasView's
    // aHeld branches test exactly those two drag kinds, so offering it on a
    // multi-resize would be advertising a key that does nothing.
    { keys: ["A"], label: "Anchor snap", when: (c) => editMode(c) && (c.dragKind === "move" || c.dragKind === "resize") && c.snapEngaged },
    // POINT-DRAG CANCEL (Round 18 audit INV5). DISPLAY-ONLY, guarded on a live drag
    // whose Escape CanvasView claims (ESC_CANCELABLE_DRAG_KINDS — the modifier-point
    // and arrow-endpoint grabs): it owns the actual Escape→cancel via a CAPTURE-phase
    // listener, which it MUST, to pre-empt App's bubble-phase `deselect` Escape so
    // the selection survives the cancel. This entry exists ONLY so the registry knows
    // the input and the HintBar shows it — the same discoverability-parity treatment
    // as the A-hold anchor-snap hint above. `deselectable` keeps the Deselect chip
    // off the bar for these gestures, so Escape shows ONE meaning at a time.
    { keys: ["Escape"], label: "Cancel drag", when: (c) => editMode(c) && ESC_CANCELABLE_DRAG_KINDS.includes(c.dragKind) },
    // ── DRAG MODIFIER VERBS, GENERATED PER KIND ─────────────────────────────
    // Modifier hints auto-announce PER DRAG KIND (manifest "Drag/resize
    // modifiers": the axis-auto-lock hint pattern, extended) — same registry,
    // never a second pathway. DERIVED from DRAG_KIND_MODIFIERS so the set can
    // never fall behind the drag machine again: multi-resize read Shift/Cmd for
    // a whole release with no chip, because this list was written by hand
    // against "resize" only. Semantics per kind (all documented at the table):
    //   move        — Shift axis-locks the translation.
    //   resize      — Shift = one uniform scale factor, Cmd = about the center.
    //   multiresize — the collective box runs the SAME resizedBox math, so it
    //                 reads the same two modifiers, identically worded.
    //   place       — a crosshair creation drag inherits resize's reading
    //                 verbatim (creationRect/creationEndpoint), so same wording.
    //   band        — the selection verbs (Cmd add / Shift subtract / Alt invert).
    ...Object.entries(dragKindModifiers).flatMap(([kind, ids]) =>
      ids.map((id) => ({ ...DRAG_MODIFIER_HINTS[id], when: dragModifierContext(kind) }))),
    // Blender-style MODAL transforms (manifest "G/S modal transforms round 2"):
    // G grabs the selection (it follows the mouse with no button held), S scales
    // it about its collective center. Available with a selection in edit mode
    // (editSelection already excludes an active modal, so G/S don't re-enter).
    // These START the modal via the app; CanvasView captures the geometry and
    // drives the preview.
    { keys: ["G"], label: "Grab", when: editSelection, run: () => app.beginModalTransform("grab") },
    { keys: ["S"], label: "Scale", when: editSelection, run: () => app.beginModalTransform("scale") },
    // While a modal transform is live, ONLY its own inputs are active (editBase
    // excludes modalActive). Enter or a left click CONFIRMS (one undo unit);
    // Escape CANCELS (reverts the preview). The click is display-only here —
    // CanvasView's pointer handler commits it. The modal announcement
    // (mode · axis · buffer) is injected into the hints in App.svelte.
    // TWO "Confirm" chips is deliberate and not the duplicate-label defect: the
    // chips are distinguished by their glyphs (an Enter icon vs a mouse icon),
    // they are different MODALITIES for the same commit, and both genuinely fire
    // — hiding either would delete a real input from the bar.
    { keys: ["Enter"], label: "Confirm", when: modalTransform, run: () => app.modalCommit() },
    { keys: ["mouse_left"], label: "Confirm", when: modalTransform },
    { keys: ["Escape"], label: "Cancel", when: modalTransform, run: () => app.modalCancel() },
    // AXIS CONSTRAINTS (Blender X/Y): during a live modal, X constrains to the
    // x-axis, Y to the y-axis; same key clears, other key switches. CanvasView
    // toggles the constraint + draws the infinite axis guide through the center.
    { keys: ["X"], label: "X axis", when: modalTransform, run: () => app.modalSetAxis("x") },
    { keys: ["Y"], label: "Y axis", when: modalTransform, run: () => app.modalSetAxis("y") },
    // NUMERIC ENTRY: digits / "." / "-" build a value buffer applied EXACTLY
    // (S 2 = factor 2; G X 2 = +2 world units along X). Backspace edits it. The
    // digit/sign keys DISPATCH but don't each show a chip (hidden) — one visible
    // hint below announces the capability; the live buffer shows in the modal
    // announcement. modalAppendBuffer no-ops a grab digit with no axis (ruling).
    ...["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-"].map((ch) => ({
      keys: [ch], label: "Type value", hidden: true, when: modalTransform, run: () => app.modalAppendBuffer(ch),
    })),
    { keys: ["Backspace"], label: "Edit value", when: modalTransform, run: () => app.modalBackspace() },
    { keys: ["mouse_scroll"], label: "Pan", when: editMode },
    { keys: ["Ctrl", "mouse_scroll"], label: "Zoom", when: editMode },
    // ── DOUBLE-CLICK, GENERATED PER ACTIVATION ──────────────────────────────
    // WHAT DOUBLE-CLICK DOES IS THE WIDGET'S OWN BUSINESS (web/CanvasView's own
    // words), and there are seven answers: add a point, edit the equation, edit the
    // text, choose a source, open the widget's palette, explore its interior. Every
    // one of them fired from a DOM `dblclick` and NONE of them was ever on the bar,
    // so the app's least-guessable gesture was also its least documented — the
    // reported defect, in the user's words: "double clicking adds a new point but
    // the shortcut area didnt mention that it's not discoverable".
    //
    // DERIVED from web/widget_handlers.activations(), which is THE table CanvasView
    // also resolves the behaviour through — one table, two readers, the construction
    // that fixed the multiresize defect. A new activation therefore cannot ship a
    // behaviour with no chip (this generator sees it) or a chip with no behaviour
    // (handlerFor resolves the same list), and it costs no edit to this file.
    //
    // DISPLAY-ONLY, and structurally so: the main key is a mouse token, which
    // dispatch() can never match, and core/shortcuts.add() now THROWS on a gesture
    // entry that claims otherwise. The pointer code owns delivery, exactly as it
    // does for "Select / drag", the wheel's Pan/Zoom, every drag modifier and every
    // creation step's chip.
    ...activations.map(({ handlerId, label }) => ({
      keys: [MOUSE_DOUBLE_TOKEN], label, when: activatable(handlerId),
    })),
    // PRESENT-MODE keys (Round 18 audit INV5). DISPLAY-ONLY: PresentMode.svelte
    // owns the actual dispatch via its own CAPTURE-phase window listener (it
    // stopPropagation()s to claim these keys during the fullscreen takeover and
    // drives the presenter lifecycle) — the SAME registered-but-externally-
    // dispatched pattern as the pointer/modifier/A-key hints. Registering EVERY
    // present key (not just Left/Right/Esc) closes the audit gap where
    // Space/PageDown/PageUp existed in the listener but NOT the registry.
    // Keep in sync with PresentMode.onkeydown.
    { keys: ["Right"], label: "Next slide", when: presentMode },
    { keys: ["Space"], label: "Next slide", hidden: true, when: presentMode },
    { keys: ["PageDown"], label: "Next slide", hidden: true, when: presentMode },
    { keys: ["Left"], label: "Prev slide", when: presentMode },
    { keys: ["PageUp"], label: "Prev slide", hidden: true, when: presentMode },
    { keys: ["Escape"], label: "Exit", when: presentMode },
    // ── THE COMMAND PALETTE'S OWN KEYS ──────────────────────────────────────
    // DISPLAY-ONLY: CommandPalette.svelte owns the dispatch (its input is focused,
    // so App's onKeydown early-returns on the typing target and the palette's own
    // handler stopPropagation()s what it claims). Registered because the palette
    // was the single worst offender against the invariant: five real keys, and the
    // bar showed exactly ONE chip — the "Palette" toggle, which cannot even fire
    // while the palette is open (onKeydown returns early on paletteOpen, so
    // Cmd+Shift+P closes nothing). That chip is now scoped to editMode, which
    // excludes paletteOpen, so the palette-open bar shows the palette's real keys
    // and nothing else. Keep in sync with CommandPalette.onkeydown.
    { keys: ["Escape"], label: "Back / close", when: paletteContext },
    // Backspace on an EMPTY query inside a submenu does the same `back()` Escape
    // does — an alias of a visible chip, so hidden (the alias rule above).
    { keys: ["Backspace"], label: "Back / close", hidden: true, when: paletteContext },
    { keys: ["Up"], label: "Prev result", when: paletteContext },
    { keys: ["Down"], label: "Next result", when: paletteContext },
    { keys: ["Enter"], label: "Run", when: paletteContext },
    // ── WYSIWYG RICH-TEXT EDITING (Round 13.4) ──────────────────────────────
    // While a text box is edited in place, the bar announces the per-selection
    // format shortcuts. DISPLAY-ONLY — TextEditController's own keydown handles
    // them (the focused contentEditable is a typing target, so editBase is false
    // and no registry `run` could fire). They route THROUGH the registry so the
    // HintBar knows them (the "only registered inputs may exist" convention).
    // Rich-text formatting is gated on textEditingRich so it neither dispatches
    // nor appears while a PLAINTEXT box is inline-edited (plain-string mode has no
    // runs/styling; these would be no-ops + clutter).
    { keys: ["Cmd", "B"], label: "Bold", when: richTextEdit },
    { keys: ["Cmd", "I"], label: "Italic", when: richTextEdit },
    { keys: ["Cmd", "U"], label: "Underline", when: richTextEdit },
    // The size steppers are ONE physical key each, whose token depends on Shift:
    // TextEditController accepts "=" or "+" for bigger and "-" or "_" for smaller.
    // The unshifted face is the visible chip (it is what the keycap says); the
    // shifted face is a hidden alias. These were registered as "Plus"/"Minus" —
    // tokens no KeyboardEvent ever produces — so the bar printed the literal WORDS
    // "Plus"/"Minus" at the user while the real keys went unnamed. core/shortcuts
    // RETIRED_KEY_TOKENS now throws on that spelling at registration.
    { keys: ["Cmd", "="], label: "Bigger", when: richTextEdit },
    { keys: ["Cmd", "+"], label: "Bigger", hidden: true, when: richTextEdit },
    { keys: ["Cmd", "-"], label: "Smaller", when: richTextEdit },
    { keys: ["Cmd", "_"], label: "Smaller", hidden: true, when: richTextEdit },
    // Editing-buffer history and select-all work in BOTH plain and rich inline
    // edit (TextEditController handles them before any rich-only branch), and are
    // a SEPARATE undo stack from the document's — the reason they must be
    // announced: the same keycaps mean something different here than on the canvas.
    { keys: ["Cmd", "Z"], label: "Undo typing", when: textEdit },
    { keys: ["Cmd", "Shift", "Z"], label: "Redo typing", when: textEdit },
    { keys: ["Cmd", "Y"], label: "Redo typing", hidden: true, when: textEdit },
    { keys: ["Cmd", "A"], label: "Select all", when: textEdit },
    // Esc applies to BOTH plain and rich editing (commit + exit).
    { keys: ["Escape"], label: "Done editing", when: textEdit },
    // WYSIWYG LATEX EDITING: while a MathLive field is open the bar announces the
    // exit gesture. DISPLAY-ONLY (the field is a typing target, so editBase is
    // false — LatexEditController's own Escape handler commits).
    { keys: ["Escape"], label: "Done editing", when: latexEdit },
    // CODE editing (CodeEditController overlay): DISPLAY-ONLY (the focused
    // textarea is a typing target; the panel's own handler acts). Tab/Shift+Tab
    // are announced because a textarea does NOT indent by default — the panel
    // overrides the browser's focus-move, which is exactly the kind of
    // app-specific rebinding the bar exists to teach. Cmd+Enter commits like
    // Escape does, so it is that chip's hidden alias.
    { keys: ["Escape"], label: "Done editing", when: codeEdit },
    { keys: ["Cmd", "Enter"], label: "Done editing", hidden: true, when: codeEdit },
    { keys: ["Tab"], label: "Indent", when: codeEdit },
    { keys: ["Shift", "Tab"], label: "Outdent", when: codeEdit },
    // ── A FOCUSED NUMERIC FIELD ─────────────────────────────────────────────
    // DISPLAY-ONLY: lib/DraggableNumber.svelte and web/AngleField.svelte read the
    // modifier themselves. Registered because "Shift makes the adjustment finer"
    // is APP-INVENTED vocabulary nobody can guess, and because it is a held
    // modifier that changes a LIVE DRAG — the same class of hidden verb the
    // multiresize defect was. Scrubber (DraggableNumber) and dial (AngleField)
    // read Shift OPPOSITE ways, so each gets its own truthful wording rather than
    // one averaged chip. Arrow keys are NOT registered: Up/Down on a spinbutton
    // and Left/Right on a slider are the platform's own ARIA conventions, already
    // known, and eight more chips would drown the invented ones.
    // `fieldFocus` is what keeps this from becoming a NEW lie: a canvas gesture in
    // flight or armed outranks the focused field for Shift (see its docstring). The
    // field's OWN drag never sets app.dragging — that flag is CanvasView's — so the
    // chip stays up while actually scrubbing, which is when it is needed.
    { keys: ["Shift"], label: "Fine adjust", when: fieldFocus("scrubber") },
    { keys: ["Shift"], label: "Coarse adjust", when: fieldFocus("dial") },
    // Home/End jump to the bounds, and only EXIST when the field has both (the
    // component returns early otherwise) — so the chips are gated on the same
    // fact, read off the focused element's aria-valuemin/max in App.svelte.
    { keys: ["Home"], label: "Minimum", when: (c) => fieldFocus("scrubber")(c) && c.numericFieldBounded },
    { keys: ["End"], label: "Maximum", when: (c) => fieldFocus("scrubber")(c) && c.numericFieldBounded },
    // ── WIDGET CANVAS MODES (web/widget_handlers.js) ─────────────────────────
    // A widget's ACTIVATION may take over canvas input (double-click a Mandelbrot
    // → explore its interior), and a widget's CREATION may too (click-click-click
    // a polygon; drag the two boxes of a telescopic magnifier). Each such mode
    // contributes ITS OWN inputs here — the registry is the single source of truth
    // for what a mode does, and this is the one place those inputs become both
    // dispatch and HintBar entries, so a new mode ships with its shortcuts already
    // registered and NO edit to this file. The mode's own gesture hints are
    // display-only (CanvasView's pointer/wheel/dblclick code reads them, exactly
    // like the canvas's Pan/Zoom hints); the Escape entry is live and is generated
    // per mode so it can name what it exits.
    //
    // A MULTI-STEP creation mode adds, PER STEP: the mouse_left chip that names
    // what THIS step's gesture does (the request's "the tools on the bottom should
    // tell me that's what's going on"), and the chips for whichever modifiers that
    // step reads. Both are scoped by inCanvasStep, so step 2's wording cannot show
    // during step 1 — which is also what keeps two "box" steps from putting two
    // different labels on mouse_left in one context.
    ...canvasModes.flatMap(({ handlerId, label, hints, steps, finish, finishGesture }) => [
      ...hints.map((h) => ({ ...h, when: inCanvasMode(handlerId) })),
      ...steps.flatMap((s, i) => [
        { keys: ["mouse_left"], label: s.hint, when: inCanvasStep(handlerId, i) },
        ...(s.modifiers ?? []).map((id) => ({ ...DRAG_MODIFIER_HINTS[id], when: inCanvasStep(handlerId, i) })),
      ]),
      // The finalize key of a mode that has one (a polygon's vertex count is
      // unbounded, so only the user knows when it is done; a fixed-length sequence
      // finalizes itself and declares no key).
      ...(finish ? [{ ...finish, when: inCanvasMode(handlerId), run: () => app.finishCanvasMode() }] : []),
      // The finalize GESTURE of a mode that has one — the second of the two the
      // request names ("I hit enter to finalize or double click to finalize").
      // DISPLAY-ONLY: CanvasView's dblclick handler delivers it, and it now
      // consults this same declaration instead of finalizing any live creation
      // unconditionally, so the chip and the behaviour are one fact. VISIBLE, where
      // its predecessor had to be hidden: declared on `mouse_left`, it collided
      // with the step's real single-click chip and would have shown two meanings on
      // one combo, so it was suppressed and the gesture went unannounced entirely.
      ...(finishGesture ? [{ ...finishGesture, when: inCanvasMode(handlerId) }] : []),
      { keys: ["Escape"], label: `Exit ${label.toLowerCase()}`, when: inCanvasMode(handlerId), run: () => app.exitCanvasMode() },
    ]),
  ];
}

/**
 * The boolean-flag combinations worth probing: each flag alone, none, and the
 * few real co-occurrences (a snap engages only mid-drag; rich vs plain inline
 * text edit; a bounded numeric field is also a focused one). One positive flag at
 * a time is enough because no entry ANDs two unrelated positive flags — and if one
 * ever does, it must add its combination here, which is the same "declare the
 * context you need" discipline the predicates themselves follow.
 *
 * The `activation` combinations are NOT here: they are DERIVED from the ACTIVATE
 * handler registry and appended by hintProbeContexts, because a hand-written list of
 * handler ids would be the same mirror-of-another-module's-shape that made the
 * multiresize defect invisible.
 */
export const HINT_PROBE_FLAGS = Object.freeze([
  {},
  { hasSelection: true },
  { paletteOpen: true },
  { modalActive: true },
  { dragging: true },
  { dragging: true, snapEngaged: true },
  { hasSelection: true, dragging: true, snapEngaged: true },
  // A REAL co-occurrence: handles only exist for a selected item, so the inner
  // selection scope is never reachable without the outer one. Probing it is what
  // makes the handle entries provably live (and their item-scope counterparts
  // provably dark) rather than a claim in a comment.
  { hasSelection: true, handlesSelected: true },
  { typingTarget: true, textEditing: true, textEditingRich: true },
  { typingTarget: true, textEditing: true, textEditingRich: false },
  { typingTarget: true, latexEditing: true },
  { typingTarget: true, codeEditing: true },
  { typingTarget: true },
  { dialogOpen: true },
  { numericField: "scrubber" },
  { numericField: "scrubber", numericFieldBounded: true },
  { numericField: "dial" },
  // A REAL co-occurrence, not a hypothetical: ExportMp4Modal's width/height/fps/CRF
  // are DraggableNumbers INSIDE a dialog, so a focused scrubber and an open dialog
  // happen together every export. The field's chips must survive that (they are not
  // composed from editBase), and the truthfulness guard must see the combination or
  // it would be checking a context the user never reaches.
  { dialogOpen: true, numericField: "scrubber" },
  { dialogOpen: true, numericField: "scrubber", numericFieldBounded: true },
]);

/** The two `mode` values, as an axis. */
export const HINT_PROBE_MODES = Object.freeze(["edit", "present"]);
/** The crosshair skins CanvasView can arm (one per `app.crosshair.kind`). */
export const HINT_PROBE_CROSSHAIRS = Object.freeze([null, "band", "place"]);

/**
 * Query-shaped pure function. Every reachable shortcut context, as plain objects
 * shaped like App.svelte's shortcutCtx() output. The probe walks the cross
 * product of the axes, so an entry is "reachable" iff some real combination
 * satisfies it.
 *
 * EVERY axis value list is DERIVED, never hand-written: `dragKinds` comes from
 * web/canvas/dragKinds.js DRAG_KINDS (whose setter guard makes an unlisted kind
 * unassignable), `canvasModeIds` from the widget handler registry,
 * `canvasModeSteps` from the step lists those modes declare (so a mode that grows a
 * third step gets that step probed without editing anything here), and
 * `activationIds` from the ACTIVATE handler registry. The hand-maintained version of
 * this list is what made the multiresize defect invisible — it listed a kind nothing
 * assigned and omitted the one that mattered.
 *
 * `activationIds` joins the FLAG axis rather than becoming a seventh nested loop:
 * an activation is resolved from the SELECTED item, so it co-occurs with exactly one
 * other flag and is orthogonal to every loop axis. Crossing it as a loop would
 * multiply the whole grid by the handler count to reach the same reachable states.
 *
 * @example hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: [], app: {}}).length // 114
 * @example hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: ["insert_point"], app: {}}).length // 120
 */
export function hintProbeContexts({ dragKinds, canvasModeIds, canvasModeSteps, activationIds, app }) {
  // One extra flag set per activation: the selected widget declares it. Derived, so
  // a new activate handler is probed with no edit here.
  const flagSets = [...HINT_PROBE_FLAGS, ...activationIds.map((id) => ({ hasSelection: true, activation: id }))];
  const out = [];
  for (const mode of HINT_PROBE_MODES)
    for (const dragKind of [null, ...dragKinds])
      for (const crosshairArmed of HINT_PROBE_CROSSHAIRS)
        for (const canvasMode of canvasModeIds)
          for (const canvasModeStep of canvasModeSteps)
            for (const flags of flagSets)
              out.push({
                mode, dragKind, crosshairArmed, canvasMode, canvasModeStep,
                paletteOpen: false, hasSelection: false, handlesSelected: false, dragging: false, modalActive: false,
                snapEngaged: false, textEditing: false, textEditingRich: false,
                latexEditing: false, codeEditing: false,
                typingTarget: false, dialogOpen: false,
                numericField: null, numericFieldBounded: false,
                activation: null,
                ...flags,
                // THE SAME KIND OF APP INVARIANT as `dragging` below: App.svelte
                // resolves `activation` from the SELECTED item's plugin, so a
                // non-null activation always means there is a selection. Modelling
                // it keeps the grid describing states the user can be in.
                hasSelection: flags.activation != null || !!flags.hasSelection,
                // AN APP INVARIANT, not a convenience: CanvasView sets `dragging` and
                // `dragKind` together and clears them together, so a non-null
                // dragKind ALWAYS means a live gesture. Modelling it here keeps the
                // probe describing states the user can actually be in — a grid that
                // crosses the two independently invents "a move drag that isn't
                // dragging" and then reports contradictions no one can reach.
                dragging: dragKind !== null || !!flags.dragging,
                app,
              });
  return out;
}

/**
 * Pure function. The step-index axis a mode set implies: every index any mode
 * declares a step for, always including 0 (a mode with no sequence sits at 0). The
 * DERIVED replacement for the hand-written list this file's history warns about.
 *
 * @param {{steps: object[]}[]} canvasModes - web/widget_handlers.canvasModes() output
 * @returns {number[]}
 *
 * @example canvasModeStepAxis([]) // [0]
 * @example canvasModeStepAxis([{steps: []}, {steps: [{}, {}]}]) // [0, 1]
 * @example canvasModeStepAxis([{steps: [{}, {}, {}]}]) // [0, 1, 2]
 */
export function canvasModeStepAxis(canvasModes) {
  const most = Math.max(1, ...canvasModes.map((m) => m.steps.length));
  return Array.from({ length: most }, (_, i) => i);
}

/**
 * Pure function. The entries whose `when` NO reachable context satisfies — a
 * shortcut that does not exist: it never dispatches and never shows in the
 * HintBar, while looking completely alive in the source. That shipped twice
 * before this check existed (both armed-crosshair gesture hints ANDed `editMode`
 * with a state editMode excludes), and it is invisible to every other kind of
 * test, because nothing throws and nothing looks wrong.
 *
 * @example unsatisfiableEntries([{keys: ["Q"], label: "x", when: () => false}], [{}]).length // 1
 * @example unsatisfiableEntries([{keys: ["Q"], label: "x", when: () => true}], [{}]) // []
 */
export function unsatisfiableEntries(entries, contexts) {
  return entries.filter((e) => !contexts.some((c) => e.when(c)));
}

/**
 * The context axes on which the app SUPPRESSES keyboard dispatch wholesale, and
 * therefore the axes on which the HintBar is most able to lie. Each is a flag
 * name and the value that turns the suppression on.
 *
 * `typingTarget` and `paletteOpen`: App.svelte's onKeydown returns before
 * dispatch. `mode: "present"`: same, PresentMode owns its keys. `dialogOpen`: a
 * lib/Modal.svelte dialog owns the screen and claims keys.
 *
 * The truthfulness guard (tests/shortcut_registry_test.js) asserts that in each
 * of these contexts EVERY visible entry is SCOPED to it — i.e. turning the
 * suppression off makes the entry disappear. An entry that shows up either way is
 * an ordinary editor hint leaking into a takeover, which is precisely the "26
 * chips while typing, 6 of them real" defect.
 */
export const SUPPRESSED_AXES = Object.freeze([
  { axis: "typingTarget", value: true },
  { axis: "paletteOpen", value: true },
  { axis: "dialogOpen", value: true },
  { axis: "mode", value: "present", off: "edit" },
]);
