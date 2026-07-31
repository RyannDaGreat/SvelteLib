<!--
  ListField — THE control for a LIST property (core/lists.js): a property whose
  value is a VARIABLE-LENGTH list of records. It is the general mechanism
  web/PaintField.svelte's hand-written gradient-stop rows used to be, so the
  polygon's `points` (and the next list property, whatever it is) get the same
  affordances with nothing re-typed.

  It is driven ENTIRELY by the DECLARATION (`decl` — a PROPS row whose kind is
  "list", or core/properties.js GRADIENT_STOPS_LIST). Nothing here knows about
  vertices or gradient stops: the element's fields, their kinds, their bounds,
  the order flavour, the visibility companion key and the length floor are all
  read off the declaration, and every VALUE operation is a core/lists.js pure
  function. That is why there is no polygon- or paint-specific branch below.

  ── WHAT ONE ELEMENT ROW OFFERS (the user's four asks) ───────────────────────
    [n]        its index, 1-based (the address `points.<i>.x` refers to, minus
               the 1 — shown so a row is identifiable at all).
    [eye]      VISIBILITY — hide/show. Writes ONLY the aligned visibility
               companion (core/lists.withElementActive), so NOTHING is
               renumbered and every equation bound to a later element keeps its
               meaning. A hidden element is dimmed and simply stops
               participating: a gradient ramps between the SURVIVING stops, a
               polygon draws straight past the corner.
    [fields]   one control per declared field, chosen BY ITS KIND from the SAME
               control vocabulary every other property row uses — a `number`
               field is a NumericField (so it scrubs, and takes an `=` equation
               per element), a `color` field is the app's ColorField, an `angle`
               field the rotary dial. There are deliberately no bespoke inputs
               here: whatever a kind can do on a normal row it does inside a
               list.
    [‹ ◆ ›]    the shared KeyframeControls on the ELEMENT's own path, so one
               element keyframes/tweens across slides as a unit (PaintField's
               per-stop diamond, generalized).
    [purge]    PURGE — the destructive half, red. Splices the element out and
               RENUMBERS every later one; the tooltip says so rather than
               hiding it, and the button refuses (disabled, with the reason) at
               the declaration's `minLength`.

  ── INSERT: at the ENDS and BETWEEN, like a slide in-between ──────────────────
  Between every pair of rows — and before the first and after the last — sits a
  thin "insert here" slice: two rules and a + chip, the SAME affordance shape
  web/SlideNav.svelte's between-slides transition slice uses, because it is the
  same idea (the user's own analogy: "in the same way that we have in-betweens
  for tween between slides"). WHERE you insert decides WHAT you get, and the
  tooltip states the value BEFORE you click (it is a pure function of the list —
  core/lists.insertedElement):
    BETWEEN two elements → every field interpolated at their midpoint (a new
      stop takes the average position and the blended colour; a new vertex
      lands on the edge it splits).
    AT EITHER END        → every field extrapolated from the outermost pair,
      clamped to the field's declared bounds.
  An EMPTY list has nothing to interpolate from (insertedElement says so and
  throws), so the empty state offers a SEED insert instead, from the
  `seedElement` the caller supplies out of the property's own default.

  NO HOVER PREVIEW ON INSERT/PURGE, deliberately, though hover-to-preview is
  the house trope for a picker: this control renders from app.state(), which
  BLENDS the preview — so previewing an insert would grow the list under the
  pointer, move the very slice being hovered, fire pointerleave, revert, and
  flicker. A picker's swatches do not move; these affordances would. The
  tooltip carries the outcome instead, and the click is one undo unit.

  ── COLLAPSE: a list gets long, so it folds ───────────────────────────────────
  The user's ruling: "plural properties should be collapsible because they can
  get quite long" — a 12-vertex polygon otherwise buries every row below it in
  the Inspector. The header IS web/Inspector.svelte's category accordion, class
  for class (`.cat-header` + chevron + `.cat-title`, `aria-expanded`), because
  that is the app's ONE section-heading device and app.css says so in as many
  words ("the accordion is now a SHARED idiom … a pane must never have to opt in
  to a shared idiom"). Collapsed, it still states WHAT is inside — "12 points",
  "5 stops, 2 hidden" — so a folded row is never a mystery box.

  Collapsed-ness is VIEW state, never document state: it changes nothing that
  renders, so it neither keyframes nor belongs in a delta. It persists as a
  BROWSER setting (manifest SETTINGS TAXONOMY: viewer-local localStorage),
  exactly as the Inspector's and Tools pane's collapse maps do, keyed by the
  PROPERTY rather than the item — so collapsing a polygon's points stays
  collapsed as you select the next polygon, which is the whole point of the
  Inspector's own "collapsing Positioning stays collapsed as you switch
  selections" rule.

  ── TWO KINDS OF COLLAPSED, deliberately kept apart ───────────────────────────
  A hover-preview picker over a list REWRITES EVERY ELEMENT on each pointerenter
  (the gradient preset library: 768 DOM mutations and 13 height changes over 14
  swatches, measured) — so the rows thrash under the cursor, which is the user's
  "otherwise it flickers like crazy". While that is happening the list folds
  itself, and the header REFUSES with the reason in its tooltip (the eye's and
  purge's own discipline) rather than pretending to toggle.

  That is SUPPRESSION, and it is stored separately from the user's own choice:
  merging them would silently eat a preference the user set. `collapsed` is the
  OR of the two, and when the picker closes the list returns to whatever the
  user had it at. Suppression has two sources, one shared and one declared:
    • A WHOLE-LIST PREVIEW staged over this exact path — the SHARED seam, which
      needs no wiring at all and therefore covers every hover-preview surface at
      once (the gradient picker, a ToolsPane plugin preset with a list-valued
      prop, whatever comes next). It is told apart from the user's OWN editing by
      SHAPE: a whole-list write stages an ARRAY at the list's path, while
      scrubbing one element's field stages a sparse numeric-keyed OBJECT
      (core/deltas.js setPath) — so dragging a stop's offset never folds the row
      out from under the pointer, which would be worse than the flicker.
    • THIS CONTROL'S OWN PRESET LIBRARY being OPEN — from the CLICK, not from the
      first swatch hovered, which is what the user asked for ("collapse that for
      us upon clicking the dropdown"): the preview seam alone would not fold
      until the first swatch had already been pointed at. This used to be
      threaded in from PaintField as `forceCollapsed`, back when PaintField owned
      the picker; it is internal now that the library is mounted here.
    • `forceCollapsed` — a mount point DECLARING that some OTHER sibling control
      it owns is about to rewrite the list. Kept for that case even though no
      mount point needs it today: the picker is no longer the only thing that
      could, and it composes with the two sources above rather than replacing
      them.

  !!! THE LAYOUT IS PROVISIONAL AND EXPECTED TO BE CONSOLIDATED !!!
  The user's ruling was "the UI can use work, but functionality-wise, we need
  that to work now" — so this is one flex row per element, correctness first.
  He has already named where it goes next: x and y may end up ADJACENT in one
  compound cell (possibly equation-represented as a pair), and "we may change
  how it's done later". Nothing about the VALUE semantics depends on this
  arrangement: every write below is a core/lists.js call on a declared path, so
  the layout can be rebuilt without touching a single write.

  KNOWN BOUND (a capability the general control cannot yet express): a `color`
  element field shows an `=` equation it already holds (ColorField renders the ƒ
  mark plus the expression) but cannot ENTER one, because the universal Tier-0
  `=` field lives in web/Inspector.svelte at the row seam and is not reachable
  from inside a value control. A `number` element field has full equation entry
  (NumericField owns its own). The fix is to extract Inspector's Tier-0 field
  into a shared component — NOT to grow a second equation editor here.

  Props:
    app         — the app controller (state reads + setPreview/commitPreview).
    decl        — the LIST DECLARATION (kind "list": element/order/activeKey/…).
    path        — the list's FULL state path, e.g. ["items", id, "points"] or
                  ["items", id, "fill", "linear", "stops"].
    label       — accessible-label base for the per-field controls.
    disabled    — grays every control (a not-yet-created item's rows).
    seedElement — the element an insert into an EMPTY list creates, from the
                  property's own default; null = no seed offered.
    forceCollapsed — a mount point declaring that some OTHER control it owns is
                  rewriting this whole list right now, so the rows must not move
                  under the pointer. Folds the list WITHOUT touching the user's
                  own remembered choice. (This control's OWN preset library folds
                  the rows by itself; nothing has to be threaded in for that.)

  ── THE PRESET LIBRARY, WHEN THE DECLARATION ASKS FOR ONE ────────────────────
  A list whose declaration says `presets: COLOR_RAMP_LIBRARY` (core/properties.js
  GRADIENT_STOPS_LIST and PROPS.rampStops) renders the shared ramp preset library
  ABOVE its rows. That mount used to live PRIVATELY in web/PaintField.svelte,
  which is precisely why no property but a gradient paint could have a library —
  the Mandelbrot palette had to be a `select` over six hard-coded colour lists
  instead of this control. Moving the mount to the DECLARATION is the
  generalization; the behaviour (hover previews on the canvas, leave reverts,
  click commits one undo unit) is unchanged.

  The library is rendered as a SIBLING of `.listfield` inside a
  `.ramp-presets-and-list` wrapper, deliberately: `.listfield` must keep meaning
  "the list itself" so nothing that measures the list (its rows, its height, its
  DOM churn under a hover sweep — tests/list_ui_probe.js counts exactly that)
  starts measuring the picker's 349-swatch grid instead.

  Styling lives in app.css (.ramp-presets-and-list / .listfield / .list-*; app
  convention: no <style>).
-->
<script module>
  /**
   * Pure function. The localStorage key one list's collapsed state is remembered
   * under: its property path with the ITEM ID dropped, so the choice follows the
   * PROPERTY and not the item (web/Inspector.svelte's accordion rule — "collapsing
   * Positioning stays collapsed as you switch selections" — one level down). A
   * path that is not item-rooted keys on itself.
   *
   * @example collapseKeyFor(["items", "a1b2c3", "points"]) // "points"
   * @example collapseKeyFor(["items", "a1b2c3", "fill", "linear", "stops"]) // "fill.linear.stops"
   * @example collapseKeyFor(["vars", "ramp"]) // "vars.ramp"
   */
  export function collapseKeyFor(path) {
    return (path[0] === "items" ? path.slice(2) : path).join(".");
  }

  /**
   * Pure function. What a COLLAPSED list says about itself — the count, and the
   * hidden count when any element is hidden (the eye states are invisible while
   * folded, so a fold that omitted them would hide a real state). `label` is the
   * declaration's own PLURAL label, singularized for a count of one the way this
   * control's tooltips already pluralize inline (purgeTip's "entr(y|ies)").
   *
   * @example listSummary(12, 0, "Points") // "12 points"
   * @example listSummary(1, 0, "Points") // "1 point"
   * @example listSummary(5, 2, "Stops") // "5 stops, 2 hidden"
   * @example listSummary(0, 0, "Stops") // "no stops"
   */
  export function listSummary(total, hidden, label) {
    const plural = label.toLowerCase();
    const head = total === 0 ? `no ${plural}` : `${total} ${total === 1 ? plural.replace(/s$/, "") : plural}`;
    return hidden > 0 ? `${head}, ${hidden} hidden` : head;
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import NumericField from "./NumericField.svelte";
  import ColorField from "./ColorField.svelte";
  import BooleanField from "./BooleanField.svelte";
  import AngleField from "./AngleField.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";
  import GradientPresetPicker from "./GradientPresetPicker.svelte";
  import { getPath } from "../core/deltas.js";
  import { COLOR_RAMP_LIBRARY } from "../core/ramps.js";
  import {
    ACTIVE_FIELD, activeListPath, elementActive, elementFieldValue, elementStorageKey,
    insertedElement, withElementActive, withElementInserted, withElementPurged,
  } from "../core/lists.js";

  let { app, decl, path, label, disabled = false, seedElement = null, forceCollapsed = false } = $props();

  // ── THE PRESET LIBRARY, MOUNTED FROM THE DECLARATION ──────────────────────
  // A list that declares `presets: COLOR_RAMP_LIBRARY` (core/properties.js
  // GRADIENT_STOPS_LIST and PROPS.rampStops) gets the shared ramp library above
  // its rows. It is mounted HERE, in the general list control, rather than by one
  // field: web/PaintField.svelte used to own the picker privately, which is the
  // whole reason no other property could have a library and the reason the
  // Mandelbrot palette had to be a `select` over six hard-coded names.
  let hasPresets = $derived(decl.presets === COLOR_RAMP_LIBRARY);
  // IS THE LIBRARY OPEN? Folds the rows from the CLICK, not from the first swatch
  // hovered, so nothing about the list moves for the whole session (the user's
  // "preset selection for gradients should collapse that for us upon clicking the
  // dropdown"). It joins `forceCollapsed` in `suppressed` below rather than
  // replacing it — a mount point may still declare suppression for a sibling
  // control this list knows nothing about.
  let presetsOpen = $state(false);

  /** Icon glyph size for the row's own buttons — the .btn-icon size every other
   *  icon button in a panel row uses, so the rows are one height. */
  const ICON = 16;
  /** The insert seam's + glyph. Smaller than a row's icon because the seam is
   *  SHORTER than a row (app.css --a-list-insert-h) — a row-sized glyph would not
   *  fit inside the hairline band. */
  const SEAM_ICON = 12;
  /** How many decimals a value is summarized to in an insert tooltip. Enough to
   *  read a normalized coordinate (0.125) without showing float dust. */
  const SUMMARY_DECIMALS = 3;
  /** Where every list's COLLAPSED state lives — ONE map for the whole app, keyed
   *  by property path (collapseKeyFor). A BROWSER setting, per the manifest's
   *  settings taxonomy, under this control's OWN key: the Inspector's
   *  "powerrp.inspectorCollapsed" and the Tools pane's "powerrp.toolsCollapsed"
   *  are separate maps for the separate things they fold, and this is the third. */
  const COLLAPSE_KEY = "powerrp.listCollapsed";

  // The visibility COMPANION's path — the sibling key beside the list itself
  // (core/lists.activeListPath); never a field inside the element.
  let activePath = $derived(activeListPath(decl, path));
  let fields = $derived(decl.element.fields);
  // The declared length floor purge refuses to go under (a gradient needs two
  // stops); absent = no floor.
  let floor = $derived(decl.minLength ?? 0);

  // THE LIST VALUE, EVALUATED (equations already resolved by core) — which is
  // what the insert/extrapolate math needs: it interpolates NUMBERS, and a raw
  // read would hand it "= 0.25 * 2". The per-field controls take the raw read
  // themselves (NumericField/ColorField each own that split), so an element's
  // equation still shows and still edits as an equation.
  //
  // A non-array list is a fold/delta bug, NOT something to coerce: report it
  // LOUDLY and render no elements rather than spreading a numeric-keyed object
  // (PaintField's precedent for the same corrupt shape).
  let value = $derived.by(() => {
    const list = getPath(app.state(), path);
    if (list === undefined) return { list: [], active: undefined };
    if (!Array.isArray(list)) {
      console.error(`ListField: "${path.join(".")}" is not an array (delta/fold bug) — got ${JSON.stringify(list)}`);
      return { list: [], active: undefined };
    }
    return { list, active: getPath(app.state(), activePath) };
  });

  // ── COLLAPSE (see the header: view state, and two kinds of collapsed) ────────

  let collapseKey = $derived(collapseKeyFor(path));

  /** Query (reads localStorage). The persisted collapse map, or {} when the
   *  setting is absent — and a REPORT plus {} when it is corrupt, never a silent
   *  swallow (web/Inspector.svelte loadCollapsed, verbatim). */
  function loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn("PowerRP: bad listCollapsed setting, ignoring:", e);
      return {};
    }
  }

  // THE USER'S OWN choice for THIS property, and nothing else — kept apart from
  // suppression so a picker cannot eat it. Re-read whenever the key changes,
  // because one mounted control is re-used across selections (the prop-derived
  // resync web/GridSizePicker.svelte's `sel` does off its seed).
  let userCollapsed = $state(false);
  $effect(() => {
    userCollapsed = loadCollapsed()[collapseKey] === true;
  });

  // A WHOLE-LIST PREVIEW staged over this exact path: an ARRAY at the list's own
  // path is a picker rewriting every element, while a sparse numeric-keyed OBJECT
  // is the user scrubbing one element's field (core/deltas.js setPath) — which
  // must NOT fold the row being dragged. This is the shared seam: no picker has
  // to wire anything up to get the flicker fix.
  let listPreviewStaged = $derived(Array.isArray(getPath(app.previewDelta, path)));
  let suppressed = $derived(Boolean(forceCollapsed) || presetsOpen || listPreviewStaged);
  let collapsed = $derived(userCollapsed || suppressed);

  let hiddenCount = $derived(value.list.filter((_, i) => !elementActive(value.active, i)).length);
  let summary = $derived(listSummary(value.list.length, hiddenCount, decl.label ?? label));

  /**
   * Pure function. The [path, value] pairs one RAMP PRESET writes: the stop list
   * at this control's own path, plus each ASPECT the declaration has a home for
   * (`presetAspectKeys`, e.g. {loop: "rampLoop", space: "rampSpace"} — a SIBLING
   * state key beside the list, the same shape `activeKey` already has). A
   * declaration with no home for an aspect simply does not write it: a gradient
   * paint stores no loop/space today, so picking a preset there changes only the
   * stops, byte-identically to before.
   *
   * @param {{stops: object[], loop: boolean, space: string}} ramp - the picked preset
   * @returns {Array} setPreview pairs
   *
   * @example // for decl {presetAspectKeys: {loop: "rampLoop"}} at path ["items","a","rampStops"]:
   * @example // rampPreviewPairs({stops: [], loop: true}) → [[["items","a","rampStops"], []], [["items","a","rampLoop"], true]]
   */
  function rampPreviewPairs(ramp) {
    const pairs = [[path, ramp.stops]];
    for (const [aspect, key] of Object.entries(decl.presetAspectKeys ?? {}))
      if (aspect in ramp) pairs.push([[...path.slice(0, -1), key], ramp[aspect]]);
    return pairs;
  }

  /** Command. Live-previews a ramp preset while the pointer rests on its swatch —
   * EXACTLY the write pickPreset commits, staged into app.previewDelta instead, so
   * the CANVAS re-renders while the DOCUMENT stays untouched and no undo entry is
   * created (the house preview/commit contract; the manifest's hover doctrine:
   * "the document is never mutated by hovering").
   *
   * It also registers the revert as app.transientPreview, which is the FontPicker
   * fix one level out: there is exactly ONE preview slot, and a dismissal path that
   * commits whatever is staged (app.exitCanvasMode does) would otherwise commit a
   * preset the user merely POINTED AT. Registering the revert means every path that
   * calls dropTransientPreview() reverts instead of committing. */
  function previewPreset(ramp) {
    if (disabled) return;
    app.setPreview(rampPreviewPairs(ramp));
    app.transientPreview = () => app.cancelPreview();
  }

  /** Command. Drops the hover preview (the pointer left the grid, or it closed).
   * The document was never changed, so this only restores what is rendered. */
  function cancelPresetPreview() {
    app.transientPreview = null;
    app.cancelPreview();
  }

  /** Command. Applies a ramp preset DURABLY — one write, one undo unit. The
   * transient registration is dropped FIRST so the commit is the user's choice and
   * not a revert target. */
  function pickPreset(ramp) {
    if (disabled) return;
    app.transientPreview = null;
    app.setPreview(rampPreviewPairs(ramp));
    app.commitPreview();
  }

  /** Query (reads the list + the suppression state). The collapse header's
   *  tooltip: what a click does — or, while a sibling control holds the list
   *  folded, WHY it is refusing, which is the same say-the-reason discipline the
   *  eye and the purge button already follow instead of going quietly inert. */
  function collapseTip() {
    // The suppressed branch KEEPS BOTH of its clauses. The fold is not the
    // user's doing here, so it owes them a reason AND the promise that their
    // own setting comes back — tests/list_ui_probe.js pins both, and the
    // brevity sweep was wrong to read the promise as implied by "while".
    // Only the trailing "when the preview ends" went, which "while" does imply.
    if (suppressed) return `Folded while something previews the whole list (${summary}), so the rows cannot move under your pointer. It reopens to your own setting after.`;
    if (collapsed) return `Folded — ${summary}. Click to open.`;
    return `Open — ${summary}. Click to fold away; remembered for this property.`;
  }

  /** Command. Toggles the USER's collapse choice and persists it. Re-READS the
   * map immediately before writing: two list controls can be mounted at once (a
   * fill gradient's stops and a stroke gradient's), and writing a snapshot taken
   * at mount would clobber whatever the sibling stored since. */
  function toggleCollapsed() {
    const next = !userCollapsed;
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ ...loadCollapsed(), [collapseKey]: next }));
    userCollapsed = next;
  }

  /**
   * Pure function. One value as insert-tooltip text: a number rounded to
   * SUMMARY_DECIMALS, anything else its own string form (a colour hex reads as
   * itself).
   *
   * @example // summarized(0.5) === "0.5"
   * @example // summarized(0.1249999) === "0.125"
   * @example // summarized("#808080") === "#808080"
   */
  function summarized(v) {
    return typeof v === "number" ? String(+v.toFixed(SUMMARY_DECIMALS)) : String(v);
  }

  /** Query (reads the declaration). An element as "x 0.5, y 0.25" — the VALUE an
   *  insert affordance is about to create, named field by field so "insert HERE"
   *  is unambiguous before the click. */
  function elementSummary(el) {
    return fields.map((f) => `${f.name} ${summarized(elementFieldValue(decl.element, el, f.name))}`).join(", ");
  }

  /** Query (reads the list). The insert slice's tooltip at `index`: WHERE the new
   *  entry lands, HOW it was derived, and WHAT it will hold — the last part from
   *  core/lists.insertedElement, the same pure function the click commits, so the
   *  tooltip can never disagree with the result. */
  function insertTip(index) {
    const summary = elementSummary(insertedElement(decl, value.list, index));
    // "extrapolated outward from the first two" → "extrapolated from the first
    // two": outward is the only direction an extrapolation off the end can go.
    if (index === 0) return `Insert before 1 — extrapolated from the first two: ${summary}`;
    if (index === value.list.length) return `Insert after ${index} — extrapolated from the last two: ${summary}`;
    return `Insert between ${index} and ${index + 1} — their midpoint: ${summary}`;
  }

  /**
   * Query (reads the list + declaration). Would hiding element `index` take the
   * VISIBLE count below the declared minLength? Then the eye is blocked.
   *
   * WHY HIDE IS GATED BY minLength AT ALL, when core/lists.withElementActive does
   * not enforce it: minLength is a statement about what the CONSUMER needs, and
   * the consumer reads visibleElements — so hiding one of a gradient's two stops
   * leaves the renderer one stop, which render_gpu/ir.js normalizeStops rejects
   * ("a gradient needs >= 2 stops"), i.e. a thrown paint on every frame. The floor
   * therefore applies to the VISIBLE count, not just the stored length, and the
   * honest place to say so is the affordance, with the reason in its tooltip.
   * Purge has the same floor for the same reason (a list with no minLength — the
   * polygon's vertices — is never gated, and every corner can be hidden).
   */
  function hideBlocked(index) {
    if (floor === 0 || !elementActive(value.active, index)) return false;
    return value.list.filter((_, i) => elementActive(value.active, i)).length <= floor;
  }

  /** Query (reads the list + declaration). The visibility toggle's tooltip: what a
   *  click will DO, plus the universal field's own explanation of hide-vs-purge —
   *  or, when the floor blocks it, why it is refusing. */
  function visibilityTip(index, visible) {
    if (hideBlocked(index))
      return `Hiding is unavailable: this list declares a minimum of ${floor}, and hiding entry ${index + 1} would leave fewer than that participating.`;
    return `${visible ? "Visible — click to hide" : "Hidden — click to show"}. ${ACTIVE_FIELD.help}`;
  }

  /** Query (reads the list + declaration). The purge button's tooltip — leading
   *  with the WORD "Purge" (this app's specific term for destroy-for-good, the
   *  item-level Purge tooltip's own register) and stating the RENUMBERING, since
   *  that is what makes it different from hide rather than a stronger hide. At the
   *  declared floor it says why it is refusing instead of silently doing nothing. */
  function purgeTip(index) {
    // Both branches keep their SUBSTANCE (the floor; the renumbering) and lose
    // the trailing pointer to the eye — the eye is the button beside this one,
    // and the hide tip already says what it does.
    if (value.list.length <= floor)
      return `Purge — unavailable: this list needs at least ${floor} entr${floor === 1 ? "y" : "ies"}. Hide it instead.`;
    return `Purge entry ${index + 1} — renumbers the later entries, shifting equations bound to them.`;
  }

  /** Command. Commits a LIST VALUE whose ELEMENT LIST moved (insert / purge) as
   * ONE undo unit: the list, plus its companion only when there IS one — writing
   * an all-true companion into a document that never hid anything would mint
   * state nobody asked for (web/app.svelte.js purgeHandleSelection's own rule). */
  function commitMoved(next) {
    const pairs = [[path, next.list]];
    if (next.active) pairs.push([activePath, next.active]);
    app.setPreview(pairs);
    app.commitPreview();
  }

  /** Command. HIDE/SHOW element `index` — ONE undo unit, writing ONLY the
   * visibility companion through core/lists.withElementActive (which returns the
   * element list by identity). This is the SAME write web/app.svelte.js
   * setHandleSelectionActive makes for the canvas handle toolbar: one hide
   * mechanism, so the two surfaces cannot disagree. */
  function setActive(index, active) {
    app.setPreview([[activePath, withElementActive(decl, value, index, active).active]]);
    app.commitPreview();
  }

  /** Command. Inserts a new interpolated/extrapolated element at `index` (one
   * undo unit). The element itself comes from core/lists.withElementInserted,
   * which also canonically orders a SORTED list — required on every write,
   * because the render path consumes gradient stop ORDER (core/lists.js's
   * measured warning: an out-of-order stop COLLAPSES instead of swapping). */
  function insert(index) {
    if (disabled) return;
    commitMoved(withElementInserted(decl, value, index));
  }

  /** Command. Inserts the FIRST element of an empty list from the property's own
   * default (`seedElement`) — the honest answer to insertedElement's "an empty
   * list has no element to interpolate from", which is why that function throws
   * rather than inventing one. */
  function seed() {
    if (disabled || !seedElement) return;
    commitMoved({ list: [seedElement], active: undefined });
  }

  /** Command. PURGES element `index` (one undo unit). Refuses below the declared
   * minLength — core/lists.withElementPurged throws there, and the button is
   * already disabled with the reason in its tooltip, so this guard is the second
   * of two loud reports, never a silent swallow. */
  function purge(index) {
    if (disabled) return;
    commitMoved(withElementPurged(decl, value, index));
  }
</script>

<!-- One INSERT slice: two rules with a + chip between them, the shape
     SlideNav's between-slides transition slice already uses for "something
     happens at this seam". `index` is the insertion position (0 = before the
     first, list.length = after the last). -->
{#snippet insertSlice(index)}
  <Tooltip text={insertTip(index)}>
    <button
      type="button"
      class="list-insert"
      {disabled}
      aria-label={`${label}: insert at position ${index + 1}`}
      onclick={() => insert(index)}
    >
      <span class="list-insert-line"></span>
      <span class="list-insert-chip"><iconify-icon icon="mdi:plus" width={SEAM_ICON} height={SEAM_ICON}></iconify-icon></span>
      <span class="list-insert-line"></span>
    </button>
  </Tooltip>
{/snippet}

<!-- THE PRESET LIBRARY IS A SIBLING OF `.listfield`, NOT A CHILD, and the wrapper
     exists for exactly that: `.listfield` must keep meaning "the list itself" so
     nothing measuring the list (its rows, its height, its DOM churn under a hover
     sweep) starts measuring the picker's grid instead. The library is a control
     ABOVE the list, not part of it. -->
<div class="ramp-presets-and-list">
  {#if hasPresets}
    <!-- THE PRESET LIBRARY — a tiled, family-grouped grid of ramp swatches.
         HOVERING one previews it live on the CANVAS (document untouched, no undo
         entry); leaving the grid restores what was there; picking one commits as
         ONE undo unit.
         FIRST, not last, and that is structural rather than cosmetic: hovering a
         swatch rewrites the whole stop list, and a preset with a different stop
         COUNT changes the list's HEIGHT (measured: 13 height changes over 14
         swatches, from 2 rows to 12 and back). With the library BELOW, every one of
         those shoved the grid — and the tile under the cursor — inside the
         Inspector's scroller. ABOVE, the panel's own top edge anchors it, so the
         swatch being pointed at cannot move. -->
    <GradientPresetPicker
      {disabled}
      onpick={pickPreset}
      onpreview={previewPreset}
      oncancelpreview={cancelPresetPreview}
      onopenchange={(open) => (presetsOpen = open)}
    />
  {/if}
  <div class="listfield">
  <!-- THE COLLAPSE HEADER — web/Inspector.svelte's category accordion, class for
       class: the app's ONE section-heading device, which app.css keeps DELIBERATELY
       UNSCOPED so a new consumer does not have to be added to a selector group
       before a shared idiom looks shared. `.cat-rows` is deliberately NOT copied
       around the body: `.listfield` is already the column, with NO gap, because an
       insert seam must butt against the rows it sits between — .cat-rows' gap
       would prise them apart.
       It REFUSES (disabled, reason in the tooltip) while suppression holds the
       list folded, so the header can never claim to toggle a state it does not
       own — the eye's and the purge button's own discipline.
       An EMPTY list gets no header: "No entries" is already one line, so there is
       nothing to fold and a header above it would only add one.
       It does NOT take `disabled`, unlike every value control here: folding writes
       nothing to the document, and a not-yet-created item's list is exactly as long
       as a created one's — so the one affordance that shortens the panel must not be
       the one that goes away when the panel is at its most crowded. -->
  {#if value.list.length > 0}
    <Tooltip text={collapseTip()}>
      <button
        type="button"
        class="cat-header"
        aria-expanded={!collapsed}
        disabled={suppressed}
        aria-label={`${label} list: ${summary}`}
        onclick={toggleCollapsed}
      >
        <iconify-icon icon={collapsed ? "mdi:chevron-right" : "mdi:chevron-down"} width={ICON} height={ICON}></iconify-icon>
        <span class="cat-title">{summary}</span>
      </button>
    </Tooltip>
  {/if}
  {#if value.list.length === 0}
    <!-- EMPTY: nothing to interpolate between, so the only offer is a seed from
         the property's default (or a plain report when there is none). -->
    <div class="list-empty">No entries</div>
    {#if seedElement}
      <Tooltip text={`Add the first entry, from the default: ${elementSummary(seedElement)}`}>
        <button type="button" class="list-insert" {disabled} aria-label={`${label}: add the first entry`} onclick={seed}>
          <span class="list-insert-line"></span>
          <span class="list-insert-chip"><iconify-icon icon="mdi:plus" width={SEAM_ICON} height={SEAM_ICON}></iconify-icon></span>
          <span class="list-insert-line"></span>
        </button>
      </Tooltip>
    {/if}
  {:else if !collapsed}
    {@render insertSlice(0)}
    {#each value.list as el, index (index)}
      {@const visible = elementActive(value.active, index)}
      <div class="list-el" class:list-el-hidden={!visible}>
        <span class="list-index">{index + 1}</span>
        <!-- VISIBILITY: the app's ONE boolean control, but the WRITE is ours —
             it is not a single scalar (the whole canonicalized companion array
             is written, exactly as the canvas handle toolbar writes it), which
             is precisely why BooleanField takes an `oncommit` override, the way
             AngleField already does for PaintField's gradient direction. -->
        <BooleanField
          {app}
          path={[...activePath, index]}
          label={`${label} ${index + 1} ${ACTIVE_FIELD.label}`}
          value={visible}
          onIcon="mdi:eye"
          offIcon="mdi:eye-off"
          onText={visibilityTip(index, true)}
          offText={visibilityTip(index, false)}
          oncommit={(next) => setActive(index, next)}
          disabled={disabled || hideBlocked(index)}
        />
        <span class="list-fields">
          {#each fields as f (f.name)}
            {@const fieldPath = [...path, index, elementStorageKey(decl.element, f.name)]}
            {@const fieldInert = decl.elementFieldDisabled?.(el, f.name) ?? false}
            <span class="list-field">
              <!-- The field's NAME is the micro-label (it is the equation
                   address's own last segment — `points.3.x`); its human label +
                   help live in the tooltip, which is where a row's (?) chrome
                   puts the same text. -->
              <Tooltip text={f.help ?? f.label ?? f.name}>
                <span class="list-field-label">{f.name}</span>
              </Tooltip>
              {#if disabled || fieldInert}
                <!-- GRAYED display, in TWO cases sharing one idiom: a NOT-YET-CREATED
                     item's whole list (`disabled` — the Inspector renders every row of
                     one), OR a single field the declaration reports INERT for THIS
                     element (`elementFieldDisabled` — a paint-path corner's hx/hy
                     handle, which has no bezier handle to edit until its curve is
                     enabled). Either way: the stored value as read-only .disabled-val
                     text, never a live field — its value survives, it is just inert. -->
                <input type="text" class="disabled-val" value={String(elementFieldValue(decl.element, el, f.name) ?? "")} disabled />
              {:else if f.kind === "number"}
                <NumericField {app} path={fieldPath} label={`${label} ${index + 1} ${f.name}`} min={f.min ?? null} max={f.max ?? null} />
              {:else if f.kind === "color"}
                <ColorField {app} path={fieldPath} label={`${label} ${index + 1} ${f.name}`} value={elementFieldValue(decl.element, el, f.name)} {disabled} />
              {:else if f.kind === "angle"}
                <AngleField {app} path={fieldPath} label={`${label} ${index + 1} ${f.name}`} value={elementFieldValue(decl.element, el, f.name)} {disabled} />
              {:else if f.kind === "boolean"}
                <BooleanField {app} path={fieldPath} label={`${label} ${index + 1} ${f.name}`} value={Boolean(elementFieldValue(decl.element, el, f.name))} {disabled} />
              {:else}
                <!-- A declared kind this control has no editor for. Reported in
                     place rather than falling through to a text box that would
                     commit a string over a typed slot. -->
                <span class="list-field-unsupported">no "{f.kind}" control</span>
              {/if}
            </span>
          {/each}
        </span>
        <!-- ONE keyframe triad per ELEMENT, on the element's own path, so a stop or
             a vertex keyframes and tweens as a unit (PaintField's per-stop ◆,
             generalized). A grayed row has no diamonds — the Inspector's own rule
             for a not-yet-created item — but still reserves the column so the rows
             stay aligned. KNOWN BOUND: the visibility flag is keyframable (it is a
             plain boolean leaf on the companion path) but has no diamond of its own
             here, because a second triad per row doubles the row's width. -->
        <span class="kf-controls">
          {#if !disabled}
            <KeyframeControls {app} path={[...path, index]} />
          {/if}
        </span>
        <Tooltip text={purgeTip(index)}>
          <button
            type="button"
            class="btn-icon list-purge"
            disabled={disabled || value.list.length <= floor}
            aria-label={`Purge ${label} entry ${index + 1}`}
            onclick={() => purge(index)}
          >
            <iconify-icon icon="mdi:delete-forever-outline" width={ICON} height={ICON}></iconify-icon>
          </button>
        </Tooltip>
      </div>
      {@render insertSlice(index + 1)}
    {/each}
  {/if}
  </div>
</div>
