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
 *   fieldScope           a focused COMMITTABLE FIELD's declared scope (item 61):
 *                        "rename" | "commit" | "revert" | "add" | "titleRename" |
 *                        null. The generalization of numericField — read off a
 *                        data-hint-scope attribute — whose Enter/Escape verbs the
 *                        HintBar Completeness Law requires be announced.
 *   popoverOpen          an open menu/combobox/picker owns the keyboard (a TAKEOVER,
 *                        like dialogOpen — editorInput excludes it)
 *   popoverKind          which kind is open: "menu" | "combobox" | "search" |
 *                        "color" | "grid" | null (read off data-hint-popover)
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
 * @example editorInput({mode: "edit", popoverOpen: true}) // false — an open popover/menu owns its keys
 */
export const editorInput = (c) => c.mode === "edit" && !c.typingTarget && !c.dialogOpen && !c.paletteOpen && !c.popoverOpen;
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
/** Pure function. A live modal transform WHOSE KIND CAN TAKE AN X/Y CONSTRAINT.
 * `modalKind` is the discriminator inside `modalActive`, the same shape
 * `activation` is inside `hasSelection` and `dragKind` is inside `dragging`:
 * one field answers "is anything live" and also "which one", so a chip can be
 * scoped to the kind it is true for instead of to the whole family.
 * @example modalAxisConstraint({mode: "edit", modalActive: true, modalKind: "scale"}) // true
 * @example modalAxisConstraint({mode: "edit", modalActive: true, modalKind: "rotate"}) // false — the plane has one rotation axis
 * @example modalAxisConstraint({mode: "edit", modalActive: false, modalKind: null}) // false */
export const modalAxisConstraint = (c) => modalTransform(c) && MODAL_KINDS_WITHOUT_AXIS.indexOf(c.modalKind) === -1;
/** The modal kinds for which an X/Y constraint is meaningless. Kept as a NAMED
 *  list rather than inline so the predicate reads as a rule and not as a special
 *  case; it mirrors MODAL_TRANSFORM_KINDS' `axisConstrainable: false`, and
 *  handShortcutEntries cross-checks the two so they cannot drift. */
const MODAL_KINDS_WITHOUT_AXIS = ["rotate"];
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
export const editSelection = (c) => editMode(c) && c.hasSelection && !c.handlesSelected && !c.slideRail;
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
 * Pure function. KEYBOARD FOCUS IS INSIDE THE SLIDE RAIL — the scope that owns
 * the SLIDE clipboard keys.
 *
 * THE WHOLE POINT IS NOT TO STEAL Ctrl+C/Ctrl+V FROM THE CANVAS. The item
 * clipboard round-trips through the OS and the server (web/clipboard.js); the
 * slide clipboard is in-memory and holds whole folded stages. They are two
 * different clipboards, so one chord may not mean both — which of them a copy
 * went to would depend on invisible state, and the paste would be a coin flip.
 * Scoping the slide keys to rail focus resolves it the same way the handle scope
 * resolves Backspace: by `when`, so exactly one meaning is live and the HintBar
 * shows exactly one chip per key.
 *
 * `editMode(c) && c.slideRail` rather than a bare `c.slideRail`: the rail's rows
 * are real <button>s, so focusing one is NOT a typing target and every canvas
 * chip would otherwise stay up beside these. The item entries exclude
 * `slideRail` for the mirror-image reason, exactly as the item entries exclude
 * `handlesSelected`.
 *
 * @example slideRailFocus({mode: "edit", slideRail: true}) // true
 * @example slideRailFocus({mode: "edit"}) // undefined (FALSY — the canvas owns the keys; same `&&` shape as editSelection)
 * @example slideRailFocus({mode: "edit", slideRail: true, typingTarget: true}) // false — the inline rename editor owns them
 */
export const slideRailFocus = (c) => editMode(c) && c.slideRail;
/**
 * Pure function. THE ITEM CLIPBOARD'S SCOPE: ordinary editor input with focus NOT
 * in the slide rail. The complement of `slideRailFocus` inside editMode, so
 * Ctrl+V has exactly one meaning at any moment.
 *
 * Its selection-bearing siblings need no equivalent: `editSelection` ALREADY
 * excludes `slideRail`, which stands the whole item-selection family down while
 * the rail has focus (that is what keeps rail Backspace from also deleting the
 * selected widget). This exists only for `paste`, the one item entry that gates
 * on editMode rather than on a selection.
 *
 * @example itemClipboardScope({mode: "edit"}) // true
 * @example itemClipboardScope({mode: "edit", slideRail: true}) // false — the rail owns the clipboard keys
 */
export const itemClipboardScope = (c) => editMode(c) && !c.slideRail;
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
// `wire` joins these for the reason the other two are here: an in-flight wire is a
// gesture with a visible provisional state (the ghost) and nothing committed yet, so
// Escape must abandon it without writing. It matters MORE here than for the other
// two, because a wire drag that picked up an EXISTING connection is holding a real
// wire hostage — releasing it over empty space would DELETE that connection, and
// without an Escape the only way out of a mistakenly-grabbed wire would be to
// complete a gesture you did not want and then undo it.
export const ESC_CANCELABLE_DRAG_KINDS = Object.freeze(["modifier", "endpoint", "wire"]);
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

// ── THE HINTBAR COMPLETENESS LAW (item 61) — CONTEXTUAL FIELD & POPOVER SCOPES ─
// The generalization of fieldFocus from two hardcoded numeric kinds to arbitrary
// DECLARED ones. A committable field or an open popover marks itself with a DOM
// data attribute (App.svelte focusContext reads it into fieldScope / popoverKind),
// and these predicates gate the DISPLAY-ONLY Enter/Escape/nav entries that announce
// its verbs. That retires the sweep's "LOCAL" drift: an Enter that commits or an
// Escape that cancels is app meaning, so it MUST show on the bar while it applies.
/**
 * Pure function. A focused COMMITTABLE FIELD of `scope` OWNS its commit/cancel keys.
 *
 * The direct heir of `fieldFocus`, and its exclusions are the same idea one axis
 * over: a live canvas takeover (a drag, an armed crosshair, a modal transform, an
 * open palette/dialog/popover) is the more specific thing the user is doing and
 * OWNS Enter/Escape, so the field stands down under it. Deliberately does NOT exclude
 * `canvasMode`: the Mandelbrot interior-explore mode MOUNTS a readout field
 * (CanvasToolbar), so a committable field lives INSIDE a canvas mode — and while that
 * field holds focus it is a typing target, which already stands the mode's own keys
 * down (editBase excludes typingTarget), so no exclusion is needed and adding one
 * would wrongly blank the field's chips.
 *
 * @example fieldScope("rename")({mode: "edit", fieldScope: "rename"}) // true
 * @example fieldScope("rename")({mode: "edit", fieldScope: "commit"}) // false
 * @example fieldScope("commit")({mode: "edit", fieldScope: "commit", modalActive: true}) // false
 */
export const fieldScope = (scope) => (c) =>
  c.mode === "edit" && c.fieldScope === scope
  && !c.paletteOpen && !c.dialogOpen && !c.modalActive && !c.popoverOpen;
/**
 * Pure function. An open popover/menu/combobox of `kind` OWNS the keyboard. A
 * TAKEOVER, like a dialog: editorInput already excludes popoverOpen, so the canvas
 * chips are gone and only these show. `mode === "edit"` because present mode is the
 * other takeover and both bind Escape (a bar reading "Exit" and "Close" on one key
 * is the lie this scoping prevents — the paletteContext precedent).
 *
 * @example popover("menu")({mode: "edit", popoverOpen: true, popoverKind: "menu"}) // true
 * @example popover("menu")({mode: "edit", popoverOpen: true, popoverKind: "combobox"}) // false
 * @example popover("menu")({mode: "present", popoverOpen: true, popoverKind: "menu"}) // false
 */
export const popover = (kind) => (c) => c.mode === "edit" && c.popoverOpen && c.popoverKind === kind;
/**
 * Pure function. A modal lib/Modal.svelte DIALOG owns the screen. The dialogOpen
 * axis ALREADY suppressed dispatch (editorInput); this is what finally ANNOUNCES the
 * dialog's own two keys instead of leaving them a silent takeover. `mode === "edit"`
 * so it cannot collide with presentMode's Escape "Exit" in the (unreachable) probe
 * crossing of a dialog with present mode.
 *
 * @example dialogContext({mode: "edit", dialogOpen: true}) // true
 * @example dialogContext({mode: "present", dialogOpen: true}) // false
 */
export const dialogContext = (c) => c.mode === "edit" && c.dialogOpen;

/**
 * Command-bound key combos: the EDITOR-setting defaults (core/keybindings.js),
 * overridable per user. The bridge (toShortcutEntries) turns them into registry
 * entries, so EVERYTHING still routes through the command registry (the manifest
 * invariant) and the palette displays each command's keys automatically.
 * `when` names a resolver in WHEN_RESOLVERS.
 */
export const KEYBINDING_DEFAULTS = [
  { command: "toggle-palette", keys: ["Cmd", "Shift", "P"], when: "editMode" },
  // THE UNIVERSAL SAVE BINDING, bound to a DISPATCHER rather than to either save
  // command, because Cmd+S means two different things depending on one piece of
  // state: quick-save for a project that is in the library, Save As… for a draft
  // that is not (draftKeys.saveCommandFor is the rule, doctested in bare node).
  //
  // WHY NOT TWO ENTRIES with `when` gates. Two bindings on one chord is a conflict
  // the registry would have to arbitrate at dispatch time — and it is also a lie
  // to the HintBar, which would have to show both or pick one. One entry, one
  // shown key, one command that decides; the decision lives in a pure function a
  // test can execute rather than in the keymap.
  { command: "save-dispatch", keys: ["Cmd", "S"], when: "editMode" },
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
  // THE CLIPBOARD KEYS ARE SCOPED, because there are TWO clipboards. Focus in
  // the slide rail means these chords act on SLIDES (the entries below); anywhere
  // else they act on items, as they always have. The two scopes are complementary
  // by construction — `editSelection` excludes `slideRail` and `slideRailFocus`
  // requires it — so exactly one meaning is live and the HintBar shows one chip
  // per key, the same disambiguation-by-`when` the handle scope uses for
  // Backspace. Only `paste` needs a predicate of its own (itemClipboardScope):
  // it is the one item entry gated on editMode rather than on a selection.
  { command: "copy-item", keys: ["Ctrl", "C"], when: "editSelection" },
  // COPY PROPERTIES — Cmd+Shift+C, the user's own choice of chord ("command
  // shift c can do this"). Deliberately the COPY key plus a modifier: it is the
  // same verb over a different unit (the widget's STATE rather than the widget),
  // so the shifted twin says that relationship the way Cmd+Shift+F/B say theirs.
  // Same `editSelection` scope as copy-item, for the same reason — it needs a
  // selection to capture, and the rail scope must keep owning the slide keys.
  // There is NO paste twin: paste dispatches on what is on the clipboard (the
  // user's "paste behaves as normal"), so a second paste chord would be a key
  // for something the one key already does.
  { command: "copy-properties", keys: ["Cmd", "Shift", "C"], when: "editSelection" },
  { command: "paste", keys: ["Ctrl", "V"], when: "itemClipboardScope" },
  // 14.9: Cmd/Ctrl+D = Duplicate. FLAGGED — the binding is the convention
  // candidate PENDING USER RATIFICATION (Cmd+D is the browser bookmark key;
  // onKeydown preventDefaults on dispatch so the bookmark is suppressed while
  // editing). No existing binding uses D, so createKeybindings finds no
  // conflict (keybindings_test guards this).
  { command: "duplicate", keys: ["Cmd", "D"], when: "editSelection" },
  // ── THE SLIDE CLIPBOARD, scoped to rail focus ─────────────────────────────
  // Same three chords, one level up: with a slide row focused they act on
  // SLIDES. Ctrl (not Cmd) on copy/paste mirrors the item entries exactly —
  // core/shortcuts.js matches Cmd and Ctrl alike, so one entry covers both
  // platforms and the two scopes use identical vocabulary.
  { command: "copy-slides", keys: ["Ctrl", "C"], when: "slideRailFocus" },
  { command: "paste-slides", keys: ["Ctrl", "V"], when: "slideRailFocus" },
  { command: "duplicate-slides", keys: ["Cmd", "D"], when: "slideRailFocus" },
  // Backspace deletes the SELECTED SLIDES from the rail — the same
  // harder-gesture-bigger-consequence family as the item/handle scopes, one
  // level up again. No Cmd+Backspace twin: a slide has no hide-vs-purge
  // distinction (its `enabled` flag is the eye toggle, not a delete).
  { command: "delete-slides", keys: ["Backspace"], when: "slideRailFocus" },
  { command: "put-on-top", keys: ["Cmd", "Shift", "F"], when: "editSelection" },
  { command: "put-on-bottom", keys: ["Cmd", "Shift", "B"], when: "editSelection" },
  // Brackets, NOT arrows (user ruling 2026-07-28): the ARROW KEYS nudge the
  // selection one pixel per press; [ and ] are the slide-navigation keys.
  { command: "prev-slide", keys: ["["], when: "editMode" },
  { command: "next-slide", keys: ["]"], when: "editMode" },
  { command: "nudge-left", keys: ["Left"], when: "editSelection" },
  { command: "nudge-right", keys: ["Right"], when: "editSelection" },
  { command: "nudge-up", keys: ["Up"], when: "editSelection" },
  { command: "nudge-down", keys: ["Down"], when: "editSelection" },
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
  // ONE LABEL for the one chord, even though it runs one of two commands: the
  // HintBar shows what the key DOES, and both branches are "save" — which of them
  // fires is a consequence of state the user can already read off the save
  // indicator, not a second thing to memorize.
  "save-dispatch": "Save",
  "delete-item": "Delete", "copy-item": "Copy", paste: "Paste",
  // "Copy state" and not "Copy properties": the HintBar chip has room for a
  // short phrase, and STATE is the user's own word for the thing ("copy state
  // button", "copy all of this state in whatever widget it is").
  "copy-properties": "Copy state",
  duplicate: "Duplicate",
  // The rail-scoped twins say SLIDE explicitly. The chord is the same and only
  // one of each pair is ever live, so the word is the only thing telling the user
  // WHICH clipboard the key in front of them is about to reach.
  "copy-slides": "Copy slides", "paste-slides": "Paste slides",
  "duplicate-slides": "Duplicate slides", "delete-slides": "Delete slides",
  "purge-item": "Purge",
  "put-on-top": "To front", "put-on-bottom": "To back",
  "prev-slide": "Prev slide", "next-slide": "Next slide", present: "Present",
  "nudge-left": "Nudge", "nudge-right": "Nudge", "nudge-up": "Nudge", "nudge-down": "Nudge",
  "band-select-regular": "Box select",
  deselect: "Deselect",
  "hide-points": "Hide points", "purge-points": "Purge points",
};

/** The `when`-name → predicate map the keybinding bridge resolves against. */
export const WHEN_RESOLVERS = { editMode, editSelection, deselectable, handlesSelected, slideRailFocus, itemClipboardScope };

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
  // THE KNOB TURN'S FINE CONTROL (WORKSTREAM BX). Shift divides the drag
  // sensitivity so the same travel moves an eighth as far
  // (core/node_knobs.knobDragValue). It gets a chip for the reason the table
  // exists: the knob gesture READS Shift and changes its outcome, and an
  // unannounced modifier that changes an outcome is precisely the defect
  // multiresize was. Knob focus's own mode hints already word it this way, so
  // this is the same sentence reaching the bar for the always-active gesture too.
  fine: { keys: ["Shift"], label: "Fine control" },
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
 * THE COMMITTABLE-FIELD SCOPES (item 61). A focused field declares one of these on a
 * `data-hint-scope` attribute; the entries are GENERATED from this table (the
 * DRAG_MODIFIER_HINTS construction), so a field cannot advertise a key this table has
 * no wording for. Each entry names ONLY the keys that field actually handles — a chip
 * for a key that does nothing would be the lie item 61 forbids, so a rename box that
 * commits on Enter and reverts on Escape lists both, while a property row that only
 * reverts on Escape lists escape alone.
 *
 * All display-only: the field's own keydown handler dispatches (a focused input is a
 * typing target, so the registry cannot), and these route through it purely for the
 * HintBar — the "registered but externally dispatched" case.
 */
export const FIELD_SCOPE_HINTS = Object.freeze({
  rename: { enter: "Rename", escape: "Cancel" }, // SlideNav slide-name editor
  commit: { enter: "Commit", escape: "Revert" }, // CanvasToolbar readouts, Numeric/Angle/Inspector equation inputs
  revert: { escape: "Revert" }, // Inspector property-row text input (Esc reverts the live preview; commit is on blur)
  add: { enter: "Add" }, // VariablesPanel add-variable input (Enter only; the rename rows commit on blur)
  // A LIVE FILTER box (the Asset Explorer's fuzzy path search). Escape ALONE, and
  // the absence of Enter is the design: the list re-filters on every keystroke, so
  // there is nothing to commit and an Enter chip would advertise a key that does
  // nothing. Its Escape does TWO things at once — clears the query AND closes the
  // box — so it is worded for both rather than borrowed from `rename`'s "Cancel",
  // which would suggest the filter merely reverts.
  filter: { escape: "Clear / Close" },
  // The Toolbar project-title chrome — a role="button" span, NOT a typing target, so
  // it stays live under editorInput and shows alongside the canvas chips. Enter and
  // F2 both open the rename modal; both are announced (F2 is app-invented vocabulary,
  // Enter is the discoverable twin). No `escape` — the span has no cancel.
  titleRename: { enter: "Rename", f2: "Rename" },
  // Focused asset/video/library TILES (AssetThumb, VideoThumbnail, lib/Thumbnail) —
  // role="button" DIVS, not real <button>s, so Enter-to-activate is app-implemented
  // (the sweep doctrine's own line: activate-a-focused-control is OS only on a genuine
  // <button>). Non-typing, so it rides the same editMode predicate as titleRename.
  tile: { enter: "Open" },
});

// The NON-TYPING field scopes: their focusable element is a role="button" (a title
// span, a tile div), NOT an <input>, so it is no typing target and stays live under
// editorInput — which means the generic fieldScope's typing-target shield does not
// apply and their Enter/F2 would collide with a canvas mode's own Enter. They are
// never focused mid-gesture, so they compose editMode (which excludes the modes and
// the crosshair) instead. Every OTHER scope is a focused <input>.
const NON_TYPING_FIELD_SCOPES = Object.freeze(["titleRename", "tile"]);

/**
 * THE OPEN-POPOVER KINDS (item 61). An open menu/combobox/picker declares one on a
 * `data-hint-popover` attribute; entries are GENERATED from this table. A popover is a
 * TAKEOVER (editorInput excludes popoverOpen), so its chips REPLACE the canvas chips.
 * LISTBOX/SLIDER ARROW NAVIGATION IS DELIBERATELY ABSENT: arrows walking a role=listbox
 * or nudging a role=slider are the platform's own ARIA conventions (the OS residue the
 * sweep doctrine still permits), so only the app-meaning verbs — dismiss, choose,
 * apply, select — are chipped, which also keeps the one-line bar from drowning.
 *
 * All display-only: the popover's own keydown handler dispatches.
 */
export const POPOVER_HINTS = Object.freeze({
  menu: [{ keys: ["Escape"], label: "Close" }], // ContextMenu, ShapePicker, ColorField, GradientPresetPicker
  combobox: [{ keys: ["Enter"], label: "Choose" }, { keys: ["Escape"], label: "Close" }], // FontPicker, lib/Dropdown
  // lib/SearchableDropdown's TWO-STAGE Escape is app-invented (a non-empty query
  // clears first, a second empty Escape closes) and cannot be guessed, so it is
  // taught with its own wording rather than combobox's plain "Close".
  search: [{ keys: ["Enter"], label: "Choose" }, { keys: ["Escape"], label: "Clear / Close" }],
  grid: [{ keys: ["Enter"], label: "Select size" }, { keys: ["Space"], label: "Select size", hidden: true }], // GridSizePicker (Space is the alias)
  // GalleryPopup's Enter does NOT choose a cell (only a click does — icons/etc.
  // are picked by clicking a tile, never by keyboard) — it reruns the search
  // NOW, skipping the debounce, exactly like CanvasToolbar's own gallery search
  // box. Reusing "search"'s "Choose" label here would be a lie about what Enter
  // does, so this is its own kind rather than a forced fit into an existing one.
  gallery: [{ keys: ["Enter"], label: "Search now" }, { keys: ["Escape"], label: "Close" }],
});

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
export function handShortcutEntries({ app, canvasModes, dragKindModifiers, modalTransformKinds, activations }) {
  // Loud cross-check (house idiom: core/properties.js BLEND_MODES ↔ LABELS): a
  // drag kind declaring a modifier this module has no wording for would silently
  // announce nothing, which is the exact defect the table exists to prevent.
  for (const [kind, ids] of Object.entries(dragKindModifiers))
    for (const id of ids)
      if (!DRAG_MODIFIER_HINTS[id])
        throw new Error(`shortcut_entries: drag kind "${kind}" declares modifier "${id}" but DRAG_MODIFIER_HINTS has no keys/label for it — add one, or the modifier would work with no chip (the multiresize defect).`);
  // The SAME loud cross-check for the modal kinds: `axisConstrainable` is declared
  // in web/canvas/dragKinds.js and the X/Y entries gate on MODAL_KINDS_WITHOUT_AXIS
  // here, so the two are a mirror — and a mirror that cannot be derived (this
  // module deliberately imports nothing from web/, which is why the table is passed
  // in) gets a gate that fails the moment they disagree.
  for (const [kind, m] of Object.entries(modalTransformKinds))
    if (m.axisConstrainable === (MODAL_KINDS_WITHOUT_AXIS.indexOf(kind) !== -1))
      throw new Error(`shortcut_entries: modal kind "${kind}" declares axisConstrainable: ${m.axisConstrainable} but MODAL_KINDS_WITHOUT_AXIS ${MODAL_KINDS_WITHOUT_AXIS.indexOf(kind) !== -1 ? "lists" : "omits"} it — the X/Y chips would then be offered for a gesture that ignores them, or withheld from one that honours them.`);
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
    // The base pointer chip STANDS DOWN when click-through is available, so the two
    // are mutually exclusive rather than two claims on one token. The registry gate
    // caught the first version doing exactly that ("shows mouse_left twice with
    // different labels — only one of them can fire, so the other is the bar lying
    // about which meaning wins") and it was right on both counts: it is one gesture
    // whose OUTCOME changed, so the chip must CHANGE, not multiply — which is also
    // how the user asked for it ("the shortcut bar should show the click-through
    // option change").
    { keys: ["mouse_left"], label: "Select / drag", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed && !(c.clickThroughDepth > 1) },
    // Shift-click ADDS/REMOVES from the multi-selection (manifest "Shift-click
    // multi-select"). Display-only, same registry pathway as the other pointer
    // hints — the pick code reads the modifier itself. Alongside "Select / drag"
    // while idle over the canvas; hidden mid-drag (shift then means axis-lock,
    // whose own hint fires) and while a crosshair mode is armed.
    { keys: ["Shift", "mouse_left"], label: "Add to selection", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed },
    // CLICK-THROUGH (user, 2026-08-02: "that click-through should show up in the
    // shortcuts, right?" — yes, and by this file's own rule: an input that is not
    // registered here does not exist, because this registry BOTH dispatches and
    // narrates). It has no key to press, so the bar is the ONLY place it can be
    // announced; without a chip the only way to discover that a second slow click
    // reaches the object underneath is to be told.
    //
    // GATED ON THE STACK ACTUALLY BEING DEEP, not merely on something being
    // selected: `clickThroughDepth` is how many objects the last selecting click
    // landed on, published by CanvasView from the traversal it already did, and
    // > 1 is exactly "there is something under this one to reach". Clicking a lone
    // object offers nothing, which is correct — a chip for an unavailable gesture
    // is the confident-wrong-answer failure the `requires` doctrine exists to stop.
    // Moving the pointer clears the count (the user's own reset condition), so the
    // offer retires with the gesture rather than lingering.
    //
    // IT SITS BESIDE THE DOUBLE-CLICK CHIP ON PURPOSE, and the pair is the whole
    // explanation: fast again = edit, slow again = go deeper.
    { keys: ["mouse_left"], label: "Click again: select underneath", when: (c) => editMode(c) && !c.dragging && !c.crosshairArmed && c.clickThroughDepth > 1 },
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
    // Blender-style MODAL transforms: G grabs the selection (it follows the mouse
    // with no button held), S scales it about its collective centre, R turns it
    // about the same centre (R6-2.1). Available with a selection in edit mode
    // (editSelection already excludes an active modal, so they don't re-enter).
    // These START the modal via the app; CanvasView captures the geometry and
    // drives the preview.
    //
    // GENERATED from MODAL_TRANSFORM_KINDS (web/canvas/dragKinds.js), not typed
    // out — the DRAG_MODIFIER_HINTS rule one gesture family over. G and S were two
    // hand-written entries and R would have been a third, in a file where the
    // matching HintBar label lived in a two-branch ternary somewhere else; a kind
    // now cannot exist without its key, its chip and its announcement.
    ...Object.entries(modalTransformKinds).map(([kind, m]) =>
      ({ keys: [m.key], label: m.label, when: editSelection, run: () => app.beginModalTransform(kind) })),
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
    // NOT for ROTATE, which has no axis to choose (the plane has ONE rotation
    // axis, so `R X` would constrain to the only option) — hence the predicate
    // reads the live modal's KIND rather than merely "a modal is open". A chip
    // for a key that would do nothing is the HintBar lie this registry forbids.
    { keys: ["X"], label: "X axis", when: modalAxisConstraint, run: () => app.modalSetAxis("x") },
    { keys: ["Y"], label: "Y axis", when: modalAxisConstraint, run: () => app.modalSetAxis("y") },
    // NUMERIC ENTRY: digits / "." / "-" build a value buffer applied EXACTLY
    // (S 2 = factor 2; G X 2 = +2 world units along X). Backspace edits it. The
    // twelve key entries DISPATCH but are hidden, because twelve chips reading
    // "0 Type value" … "9 Type value" is noise, not discovery — they are ALIASES
    // of the one REPRESENTATIVE chip below, exactly the relationship
    // Delete↔Backspace and Space↔Enter already use. The live buffer shows in the
    // modal announcement. modalAppendBuffer no-ops a grab digit with no axis (ruling).
    //
    // THE REPRESENTATIVE CHIP IS NOT OPTIONAL, and its absence was a real
    // violation of "a shortcut that isn't registered does not exist": for its whole
    // life this block's comment claimed "one visible hint below announces the
    // capability" and NO SUCH HINT EXISTED. The only visible modal chip near it is
    // Backspace "Edit value", which announces editing a buffer the user was never
    // told they could START — twelve live keys, zero discoverability. It is
    // display-only (`when` + no run/command): the twelve entries above own the
    // dispatch, this one owns the announcement. tests/shortcut_registry_test.js
    // now fails on ANY hidden entry lacking a visible same-label twin, so this
    // pairing cannot silently come apart again.
    //
    // The chip shows "0" — a REAL key that really works — rather than a "0-9"
    // range glyph, because validateShortcutKeys admits only tokens dispatch() can
    // match, and a chip naming an unpressable pseudo-key is the "Plus"/"Minus"
    // defect (RETIRED_KEY_TOKENS) all over again. The LABEL carries the range,
    // which is the half the user actually needs to learn.
    { keys: ["0"], label: "Type value (0-9 . -)", when: modalTransform },
    ...["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "-"].map((ch) => ({
      keys: [ch], label: "Type value (0-9 . -)", hidden: true, when: modalTransform, run: () => app.modalAppendBuffer(ch),
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
    // ── ENTER = DOUBLE-CLICK, THE SAME LIST ONE KEY OVER ────────────────────
    // User request (2026-08-02): "if I hit the 'enter' key wehn slecting a widget
    // and we didn't double click it yet, treat that enter key as a double click to
    // go into editing it."
    //
    // GENERATED FROM THE SAME `activations` LIST, with the SAME `activatable(handlerId)`
    // gate and the SAME label as the chip above it. That is the whole design: the two
    // inputs are one behaviour (web/CanvasView.svelte activateNode is the single entry
    // point both reach), so they are one row of this table read twice, and neither the
    // gate nor the wording can drift between them.
    //
    // These DISPATCH (unlike the mouse chips, which are display-only by construction):
    // Enter is a real key, so each carries a `run` calling the CanvasView hook. The
    // hook is installed on `app`, so this module still imports nothing from web/.
    //
    // WHY `activatable` IS ALREADY THE RIGHT FOCUS GATE, unchanged. It descends from
    // `editMode` → `editBase` → `editorInput`, which is exactly the set of "somebody
    // else owns the keyboard" facts Enter must respect: a focused text editor,
    // equation field or MathLive box is a `typingTarget`; a modal dialog is
    // `dialogOpen`; the palette is `paletteOpen`; a dropdown/combobox is
    // `popoverOpen`; a G/S/R modal transform is `modalActive`; an armed crosshair or
    // a live widget canvas mode is excluded by `editMode` itself. Every one of those
    // contexts binds Enter to its OWN verb, and each already registers that verb here
    // (the palette's "Run", the modal transform's "Confirm", a creation mode's
    // "Finish shape", a committable field's "Commit"/"Rename"/"Add"). So the "one
    // key, one meaning" invariant holds without a single new exclusion — the gates
    // that keep those chips off the bar are the same ones that keep this one off.
    ...activations.map(({ handlerId, label }) => ({
      keys: ["Enter"], label, when: activatable(handlerId), run: () => app.activateSelection(),
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
    // ── COMMITTABLE FIELD SCOPES, GENERATED PER SCOPE (item 61) ───────────────
    // The generalization of the fieldFocus entries above. A field declaring
    // data-hint-scope="rename"|"commit"|… gets its Enter/Escape/F2 chips here, one
    // per key the scope actually handles. DISPLAY-ONLY: the field's own keydown acts;
    // the registry announces (the numeric-field precedent one axis over).
    ...Object.entries(FIELD_SCOPE_HINTS).flatMap(([scope, verbs]) => {
      // The TYPING-TARGET scopes use fieldScope: a focused <input> is a typing target,
      // which already stands the canvas takeovers (a drag, a mode, a crosshair) down
      // via editorInput, so fieldScope need only add the non-editorInput takeovers
      // (palette/dialog/modal/popover). The NON-TYPING scopes (a title span, a tile
      // div) stay live under editorInput and would collide with a canvas mode's own
      // Enter (the polygon's "Finish shape"), so they compose editMode instead, which
      // excludes canvasMode and the crosshair outright (see NON_TYPING_FIELD_SCOPES).
      const when = NON_TYPING_FIELD_SCOPES.includes(scope)
        ? (c) => editMode(c) && c.fieldScope === scope
        : fieldScope(scope);
      return [
        ...(verbs.enter ? [{ keys: ["Enter"], label: verbs.enter, when }] : []),
        ...(verbs.escape ? [{ keys: ["Escape"], label: verbs.escape, when }] : []),
        ...(verbs.f2 ? [{ keys: ["F2"], label: verbs.f2, when }] : []),
      ];
    }),
    // ── OPEN-POPOVER KINDS, GENERATED PER KIND (item 61) ──────────────────────
    // A menu/combobox/picker declaring data-hint-popover="menu"|"combobox"|… gets its
    // dismiss/choose/apply chips here. A popover is a TAKEOVER (editorInput excludes
    // popoverOpen), so these REPLACE the canvas chips. DISPLAY-ONLY: the popover's own
    // keydown owns dispatch; a listbox's arrow navigation is OS residue and unchipped.
    ...Object.entries(POPOVER_HINTS).flatMap(([kind, hints]) =>
      hints.map((h) => ({ ...h, when: popover(kind) }))),
    // ── MODAL DIALOG KEYS (item 61) ───────────────────────────────────────────
    // dialogOpen already made editorInput false (the canvas chips stand down); these
    // finally ANNOUNCE the dialog's own takeover keys instead of leaving them silent.
    // DISPLAY-ONLY: lib/Modal.svelte's panel keydown owns Esc-close and the Tab focus
    // trap. A focused scrubber INSIDE the dialog still shows its own fieldFocus chips
    // (Export MP4's width/height), which do not collide with these.
    { keys: ["Escape"], label: "Close", when: dialogContext },
    { keys: ["Tab"], label: "Next field", when: dialogContext },
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
    ...canvasModes.flatMap(({ handlerId, label, hints, keys = [], steps, finish, finishGesture }) => [
      ...hints.map((h) => ({ ...h, when: inCanvasMode(handlerId) })),
      // A MODE'S OWN KEYS, live rather than display-only — the 3D viewport's WASDQE
      // fly (#270) and the Keyboard node's piano row (CB). Same shape as `finish`
      // one block down and for the same reason: the handler declares WHAT the key
      // means and this layer supplies the run, because `app` lives here. Routing
      // them through the registry rather than a private keydown is what keeps the
      // HintBar honest — the manifest's rule is that a shortcut which is not
      // registered does not exist.
      //
      // `method` NAMES THE APP COMMAND, defaulting to the fly (its only caller
      // when this was written, and unchanged by the default). It became a
      // declaration when a SECOND mode wanted keys: a piano key is not a fly step,
      // and hard-coding one mode's verb here would have forced the other to bind
      // its keys outside the registry — which is precisely the anti-pattern this
      // block exists to prevent. `verb` stays whatever the receiving method wants:
      // a signed unit step for the fly, a key token for the keyboard.
      ...keys.map((k) => ({
        keys: k.keys, label: k.label, hidden: k.hidden, when: inCanvasMode(handlerId),
        run: () => modeKeyRun(app, k),
      })),
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
 * Command. Runs ONE of a canvas mode's declared keys against the app.
 *
 * THE METHOD NAME IS RESOLVED, NOT GUESSED, and an unknown one THROWS. A typo
 * would otherwise produce a chip on the HintBar that the user can see, press, and
 * get silence from — the exact failure `add()`'s gesture-honesty guard and
 * `getHandler`'s unknown-id throw both exist to prevent, arriving through a third
 * door. It throws at PRESS rather than at boot because a mode's key list is data
 * from a handler module; tests/shortcut_registry_test.js sweeps the real
 * population, which is where a bad name is caught before a user meets it.
 *
 * @param {object} app - the app store
 * @param {{verb: *, method?: string}} key - one entry of a mode's `keys`
 */
function modeKeyRun(app, key) {
  const method = key.method ?? "flyCanvasMode";
  if (typeof app[method] !== "function")
    throw new Error(`canvas mode key "${key.label}" declares method "${method}", which the app store does not have — the key would silently do nothing.`);
  app[method](key.verb);
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
  // CLICK-THROUGH's reachable state: a selecting click that landed on a STACK.
  // hasSelection rides along because the click that produced the depth also
  // selected the top of that stack — modelling them together keeps the grid
  // describing states the user can actually be in, the same invariant the
  // activation and dragKind axes below are careful about.
  { hasSelection: true, clickThroughDepth: 2 },
  { paletteOpen: true },
  // NOTE: the live-modal flag sets are NOT here. They are DERIVED per modal kind
  // and appended by hintProbeContexts, for the same reason the activation ones are:
  // a hand-written `{ modalActive: true }` probes a modal with no KIND, which is a
  // state the app cannot be in, and it would make a kind-scoped chip (the X/Y axis
  // keys, which rotate must not offer) unprobeable in either direction.
  { dragging: true },
  { dragging: true, snapEngaged: true },
  { hasSelection: true, dragging: true, snapEngaged: true },
  // A REAL co-occurrence: handles only exist for a selected item, so the inner
  // selection scope is never reachable without the outer one. Probing it is what
  // makes the handle entries provably live (and their item-scope counterparts
  // provably dark) rather than a claim in a comment.
  { hasSelection: true, handlesSelected: true },
  // FOCUS IN THE SLIDE RAIL — the scope that owns the SLIDE clipboard keys. Both
  // halves are reachable and both must be probed: with an item selected (the real
  // case, and the one where the item entries must stand DOWN — that is what makes
  // the Ctrl+C hand-off provable rather than asserted in a comment) and without.
  { slideRail: true },
  { slideRail: true, hasSelection: true },
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
  // item-61 COMMITTABLE-FIELD SCOPES and OPEN POPOVERS — DERIVED from the two
  // hint tables above rather than listed here.
  //
  // WHY DERIVED, and this is not tidying: these two lists used to be typed out by
  // hand, mirroring FIELD_SCOPE_HINTS and POPOVER_HINTS key for key. A new scope
  // therefore had to be added in TWO places, and forgetting the second one does not
  // fail loudly the way a missing entry usually does — it makes the new scope's
  // chips UNSATISFIABLE, so unsatisfiableEntries reports them as a bug in the
  // scope's own `when` predicate. The next reader then goes looking for a
  // contradiction in a predicate that is perfectly correct. That happened on the
  // very next scope added after this comment's ancestor was written (`filter`, the
  // Asset Explorer's path search), which is why the mirror is now gone: the hint
  // tables are the single source, and a scope that exists is probed by construction.
  //
  // The TYPING-TARGET distinction still has to be stated, because it is a real
  // property of the DOM element and not derivable from the table: a plain <input>
  // scope is a typing target (it suppresses the canvas chips the way a numericField
  // does), while a role="button" span/div scope is not (it stays live under
  // editorInput, its chips beside the canvas ones). NON_TYPING_FIELD_SCOPES is the
  // one place that fact is written, and shortcutEntries reads the SAME list when it
  // picks each scope's `when` — so the probe and the predicate cannot disagree.
  ...Object.keys(FIELD_SCOPE_HINTS).map((scope) =>
    NON_TYPING_FIELD_SCOPES.includes(scope) ? { fieldScope: scope } : { typingTarget: true, fieldScope: scope },
  ),
  ...Object.keys(POPOVER_HINTS).map((kind) => ({ popoverOpen: true, popoverKind: kind })),
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
 * THE COUNT IS STATED RELATIONALLY, not as a literal. It used to be two pinned
 * integers (174 and 180), which made every new probe flag — a new field scope, a new
 * popover kind — fail a doctest with a number nobody could interpret, in a file where
 * the number is a consequence rather than a decision. It is exactly
 * modes × dragKinds+1 × crosshairs × modes × steps × flagSets, and the flag-set count
 * now follows FIELD_SCOPE_HINTS/POPOVER_HINTS by construction (see HINT_PROBE_FLAGS).
 *
 * @example
 * // The grid is the full cross product of its axes; nothing is dropped or deduped.
 * hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: [], modalKinds: [], app: {}}).length
 *   === HINT_PROBE_MODES.length * 1 * HINT_PROBE_CROSSHAIRS.length * 1 * 1 * HINT_PROBE_FLAGS.length  // true
 * @example
 * // Each activation id adds ONE flag set (it rides the flag axis, not a loop axis).
 * hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: ["insert_point"], modalKinds: [], app: {}}).length
 *   - hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: [], modalKinds: [], app: {}}).length
 *   === HINT_PROBE_MODES.length * HINT_PROBE_CROSSHAIRS.length  // true
 * @example
 * // …and so does each MODAL KIND, for the same reason: one flag set, not a loop.
 * hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: [], modalKinds: ["grab", "rotate"], app: {}}).length
 *   - hintProbeContexts({dragKinds: [], canvasModeIds: [null], canvasModeSteps: [0], activationIds: [], modalKinds: [], app: {}}).length
 *   === 2 * HINT_PROBE_MODES.length * HINT_PROBE_CROSSHAIRS.length  // true
 */
export function hintProbeContexts({ dragKinds, canvasModeIds, canvasModeSteps, activationIds, modalKinds, app }) {
  // One extra flag set per activation: the selected widget declares it. Derived, so
  // a new activate handler is probed with no edit here.
  const flagSets = [
    ...HINT_PROBE_FLAGS,
    ...activationIds.map((id) => ({ hasSelection: true, activation: id })),
    // A live modal ALWAYS has a kind, so it is probed per kind — which is what lets
    // a chip be scoped to one (rotate's missing X/Y) and still be provably live for
    // the others.
    ...modalKinds.map((kind) => ({ modalActive: true, modalKind: kind })),
  ];
  const out = [];
  for (const mode of HINT_PROBE_MODES)
    for (const dragKind of [null, ...dragKinds])
      for (const crosshairArmed of HINT_PROBE_CROSSHAIRS)
        for (const canvasMode of canvasModeIds)
          for (const canvasModeStep of canvasModeSteps)
            for (const flags of flagSets)
              out.push({
                mode, dragKind, crosshairArmed, canvasMode, canvasModeStep,
                paletteOpen: false, hasSelection: false, handlesSelected: false, dragging: false, modalActive: false, modalKind: null,
                snapEngaged: false, textEditing: false, textEditingRich: false,
                latexEditing: false, codeEditing: false,
                typingTarget: false, dialogOpen: false,
                numericField: null, numericFieldBounded: false,
                fieldScope: null, popoverOpen: false, popoverKind: null,
                activation: null,
                // Nothing clicked yet ⇒ no stack under the cursor. The deep case is
                // a probe flag below, so the click-through chip is proven live.
                clickThroughDepth: 0,
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
  // An OPEN POPOVER/MENU/COMBOBOX (item 61) is a takeover too: editorInput excludes
  // popoverOpen, so no dispatched editor entry is live behind it and every chip shown
  // there is the popover's own — the dialog precedent, one axis over.
  { axis: "popoverOpen", value: true },
  { axis: "mode", value: "present", off: "edit" },
]);
