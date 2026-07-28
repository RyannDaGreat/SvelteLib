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
  Styling lives in app.css (.listfield / .list-*; app convention: no <style>).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import NumericField from "./NumericField.svelte";
  import ColorField from "./ColorField.svelte";
  import BooleanField from "./BooleanField.svelte";
  import AngleField from "./AngleField.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";
  import { getPath } from "../core/deltas.js";
  import {
    ACTIVE_FIELD, activeListPath, elementActive, elementFieldValue, elementStorageKey,
    insertedElement, withElementActive, withElementInserted, withElementPurged,
  } from "../core/lists.js";

  let { app, decl, path, label, disabled = false, seedElement = null } = $props();

  /** Icon glyph size for the row's own buttons — the .btn-icon size every other
   *  icon button in a panel row uses, so the rows are one height. */
  const ICON = 16;
  /** How many decimals a value is summarized to in an insert tooltip. Enough to
   *  read a normalized coordinate (0.125) without showing float dust. */
  const SUMMARY_DECIMALS = 3;

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
    if (index === 0) return `Insert before 1 — extrapolated outward from the first two: ${summary}`;
    if (index === value.list.length) return `Insert after ${index} — extrapolated outward from the last two: ${summary}`;
    return `Insert between ${index} and ${index + 1} — the midpoint of the two: ${summary}`;
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
    if (value.list.length <= floor)
      return `Purge — unavailable: this list declares a minimum of ${floor} entr${floor === 1 ? "y" : "ies"}, so ${index + 1} cannot be removed. Hide it instead.`;
    return `Purge entry ${index + 1} — removes it for good and renumbers the later entries, so equations referring to them shift. Hide (the eye) keeps its place.`;
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
      <span class="list-insert-chip"><iconify-icon icon="mdi:plus" width="12" height="12"></iconify-icon></span>
      <span class="list-insert-line"></span>
    </button>
  </Tooltip>
{/snippet}

<div class="listfield">
  {#if value.list.length === 0}
    <!-- EMPTY: nothing to interpolate between, so the only offer is a seed from
         the property's default (or a plain report when there is none). -->
    <div class="list-empty">No entries</div>
    {#if seedElement}
      <Tooltip text={`Add the first entry, from this property's default: ${elementSummary(seedElement)}`}>
        <button type="button" class="list-insert" {disabled} aria-label={`${label}: add the first entry`} onclick={seed}>
          <span class="list-insert-line"></span>
          <span class="list-insert-chip"><iconify-icon icon="mdi:plus" width="12" height="12"></iconify-icon></span>
          <span class="list-insert-line"></span>
        </button>
      </Tooltip>
    {/if}
  {:else}
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
            <span class="list-field">
              <!-- The field's NAME is the micro-label (it is the equation
                   address's own last segment — `points.3.x`); its human label +
                   help live in the tooltip, which is where a row's (?) chrome
                   puts the same text. -->
              <Tooltip text={f.help ?? f.label ?? f.name}>
                <span class="list-field-label">{f.name}</span>
              </Tooltip>
              {#if f.kind === "number"}
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
        <span class="kf-controls">
          <KeyframeControls {app} path={[...path, index]} />
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
