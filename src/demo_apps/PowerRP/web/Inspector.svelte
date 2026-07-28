<!--
  Inspector — the Property Panel. Renders the properties of the current
  SELECTION TARGET, which is one of:
    - an ITEM (a widget): rows declared BY THE PLUGIN (plugin.inspector),
      organized into collapsible CATEGORY accordions (manifest Round 12), each
      row carrying keyframe controls:
        ◆/◇  insert/remove keyframe for this property on the CURRENT slide
        ‹ ›  jump to prev/next slide holding a keyframe for it
      Editing a value writes a keyframe on the current slide. Universal to every
      item: a VISIBILITY row (the `active` boolean) rendered ABOVE the categories
      so it is ALWAYS reachable — it is a property like any other, keyframeable
      with the same diamonds (manifest Round 12: visibility is a boolean property
      row). A NAME row (with the Purge trash-can beside it) sits above that.
    - a TRANSITION (a slide boundary): rows declared by the transition TYPE
      registry, rendered through the SAME generic row machinery but WITHOUT
      keyframe diamonds — a transition is per-boundary CONFIG, not keyframable
      tweened state. A type dropdown (tween|fade) switches the type, preserving
      the shared superclass props (seconds/curve/sound).

  The Inspector dispatches on app.selectionTarget?.kind so items and transitions
  (and, later, a heterogeneous multi-select intersection) route through ONE
  mechanism. app.selectionTarget is owned by the app controller; until it exists
  the Inspector falls back to the legacy single-item selection.

  Item selection uses SvelteLib's Dropdown (never the native <select>) and
  includes non-bbox widgets (blur layers) — selection doesn't require canvas
  geometry. Items are user-renamable (name lives on the creation slide).

  FIELD RESOLUTION IS TIERED (manifest "PROPERTY-INTERFACE HIERARCHY"): every
  item property row picks its SPECIALIZED editor by kind (Tier 1), but ALWAYS
  falls back to the UNIVERSAL `=` equation field (Tier 0) — see the equation
  section in the script below for which kinds route here and which own their
  equation UX themselves.
-->
<script>
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import NumericField from "./NumericField.svelte";
  import BooleanField from "./BooleanField.svelte";
  import ColorField from "./ColorField.svelte";
  import PaintField from "./PaintField.svelte";
  import AngleField from "./AngleField.svelte";
  import AssetField from "./AssetField.svelte";
  import ListField from "./ListField.svelte";
  import EquationSuggest from "./EquationSuggest.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";
  import { allDocumentItems, keyframeIndices, foldState, itemFallbackName } from "../core/document.js";
  import { transitionInspector, TRANSITION_TYPES } from "../core/transitions.js";
  import {
    canonicalPropPath, compiled, displayToStored, storedToDisplay, equationTokenSpans, isEquationValue,
  } from "../core/expressions.js";
  import { suggestEquation, acceptSuggestion } from "../core/equationSuggest.js";
  import { PROPS, RETIRED_ROW_KINDS, selectRowItems } from "../core/properties.js";
  import { LIST_ROW_KIND } from "../core/lists.js";
  import { MIXED_MARK, fanOutPairs } from "../core/multiselect.js";
  import { commandUnavailableReason } from "../core/commands.js";
  import { isHexColor } from "../core/interpolators.js";
  import { getPath } from "../core/deltas.js";
  import { copyText } from "./clipboard.js";

  let { app } = $props();

  // How long the copy-path button flashes its "Copied!" check after a
  // successful copy (positive feedback — the button icon swaps to a check).
  const COPY_FLASH_MS = 1200;
  // The row `key` whose copy button is currently flashing "Copied!", or null.
  let justCopiedKey = $state(null);

  // ── Selection-target dispatch (item | transition | none) ─────────────────────
  // app.selectionTarget is the agreed cross-target shape (owned by the app
  // controller). Until it lands, fall back to the legacy single-item selection
  // so the item path keeps working unchanged.
  let target = $derived(
    app.selectionTarget ?? (app.selection != null ? { kind: "item", itemId: app.selection } : null)
  );

  let nodes = $derived(app.nodes());
  /** The selected item as the node-shaped {itemId, type, state, plugin} the
   * template consumes. The render tree derives only items VISIBLE on this
   * slide, but the picker lists EVERY document item (manifest: "Item picker
   * shows ALL objects on ALL slides") — an item that is active:false here still
   * has folded state, so build the same shape from the state and every row keeps
   * working (it just doesn't render on canvas). An item NOT YET CREATED on this
   * slide has no folded state at all → null; the template then renders its rows
   * GRAYED from its creation-slide state, with the visibility row still
   * actionable (manifest Round 12B). */
  let sel = $derived.by(() => {
    if (target?.kind !== "item") return null;
    const live = app.selectedNode();
    if (live) return live;
    const state = app.state().items?.[target.itemId];
    if (!state) return null;
    return { itemId: target.itemId, type: state.type, state, plugin: app.registry.get(state.type) };
  });

  // Picker: items visible on this slide first (render-tree order, as before),
  // then every OTHER document item — not yet created here, or active:false — at
  // the BOTTOM, flagged `invisible` for the red style (manifest, round 11).
  let itemChoices = $derived.by(() => {
    const visible = nodes.map((n) => ({ value: n.itemId, label: app.displayName(n.itemId) }));
    const visibleIds = new Set(nodes.map((n) => n.itemId));
    const invisible = allDocumentItems(app.doc)
      .filter((it) => !visibleIds.has(it.id))
      .map((it) => ({
        value: it.id,
        label: it.name ?? itemFallbackName(app.registry.get(it.type).title, it.id),
        invisible: true,
      }));
    return [...visible, ...invisible];
  });

  // The currently-picked item id (whether created here or not) — drives the
  // name row, the not-yet-created path, and the picker value.
  let pickedItemId = $derived(target?.kind === "item" ? target.itemId : null);
  // Creation slide of the picked item (first slide keying its type).
  let creationIndex = $derived(pickedItemId == null ? null
    : keyframeIndices(app.doc, ["items", pickedItemId, "type"])[0] ?? null);
  // Number of selected items — >1 renders the INTERSECTION panel below.
  let selCount = $derived(app.selectedIds().length);

  // ── MULTI-SELECTION: the intersection panel (core/multiselect.js) ───────────
  // All the reasoning — the row-identity relation, mixed-value semantics, which
  // items participate, what a joint write touches — lives in core. This file is
  // the thin renderer the manifest asks for: it reads ONE derived object and
  // renders the SAME propRow snippet single selections use.
  let multiPanel = $derived(selCount > 1 ? app.multiSelectPanel() : null);
  // key → {row, mixed, value, seed, problem}, so grouping can stay row-shaped
  // (groupRows is reused verbatim) while each row still finds its own set state.
  let multiByKey = $derived(new Map((multiPanel?.rows ?? []).map((r) => [r.row.key, r])));
  let multiCategories = $derived(multiPanel ? groupRows(multiPanel.rows.map((r) => r.row)) : []);

  /** Query. Every selected item's state path for one row key — the fan-out write
   * targets a Tier-1 field receives as `paths` (the primary FIRST, so the field's
   * singular `path` and this list agree about who is being read). */
  function multiPaths(key) {
    return (multiPanel?.itemIds ?? []).map((id) => ["items", id, ...key.split(".")]);
  }

  /**
   * Command. UNIFIES a mixed row to the primary's value — the user's "when I
   * click them, it would have to unify them all to the same value". ONE undo unit
   * for the whole set (app.unifySelection). After it lands the row is no longer
   * mixed, so the ordinary field takes over and the next gesture edits all N
   * together, which is the "make a bunch of things fade in at the same time" flow.
   */
  function unifyRow(entry) {
    app.unifySelection(entry.row.key, entry.seed);
  }

  /**
   * Pure function. A value as short human text for the unify affordance's
   * tooltip, so "set them all to …" NAMES the value instead of being a mystery
   * click. Reuses the equation badge's elision budget, and shows a structural
   * value (a gradient paint, a rich-text run set) as its type rather than as a
   * wall of JSON.
   *
   * @example multiValueLabel(0.5) // "0.5"
   * @example multiValueLabel("=cam.opacity") // "=cam.opacity"
   * @example multiValueLabel(true) // "true"
   * @example multiValueLabel({type: "linear"}) // "its current value"
   */
  function multiValueLabel(value) {
    if (value === null || typeof value === "object") return "its current value";
    const text = String(value);
    return text.length > EQ_BADGE_CHARS ? `${text.slice(0, EQ_BADGE_CHARS)}…` : text;
  }

  // NOT-YET-CREATED display state: the item's FULL folded property set as of its
  // ORIGINAL creation slide (manifest Round 12B — grayed rows show the item
  // "looking like itself", not bare defaults). null until we have a picked item
  // with a known creation slide.
  let creationState = $derived.by(() => {
    if (sel || pickedItemId == null || creationIndex == null) return null;
    return foldState(app.doc, creationIndex, 1).items?.[pickedItemId] ?? null;
  });

  // Slug-resolution state for a NOT-YET-CREATED item's path tooltip/copy-path:
  // canonicalPropPath needs every item's {type, name} to dedupe slug
  // collisions correctly (slugMap, core/expressions.js) — app.rawState()
  // won't do (it folds only THIS slide, which by definition excludes an item
  // that doesn't exist yet here). allDocumentItems(app.doc) already collects
  // {id, type, name} across every slide (used by the picker); reshape it into
  // the {items: {...}} shape canonicalPropPath expects.
  let allItemsState = $derived({
    items: Object.fromEntries(allDocumentItems(app.doc).map((it) => [it.id, { type: it.type, name: it.name }])),
  });

  // ── Category accordion ────────────────────────────────────────────────────
  // Row defs carry a `category` key (manifest Round 12). Uncategorized rows fall
  // into DEFAULT_CATEGORY. Category display titles + order are here; unknown
  // categories (future plugins) append after the known ones, titled by a
  // start-cased fallback.
  const DEFAULT_CATEGORY = "other";
  const CATEGORY_TITLES = {
    positioning: "Positioning",
    // FILL/STROKE ARE THEIR OWN TOP-LEVEL SECTIONS, peers of Positioning — NOT
    // rows inside Formatting (user ruling, twice: "they need to be their own
    // separate drop-down"). The section hosts the whole paint stack for its
    // slot: the paint mode buttons, solid/gradient editors, the Mat picker and
    // its knob fold — and, for stroke, width/trim/phase/caps.
    fillMaterial: "Fill Material",
    strokeMaterial: "Stroke Material",
    formatting: "Formatting",
    text: "Text",
    arrow: "Arrow",
    lens: "Lens",
    blur: "Blur",
    effects: "Effects",
    // CUSTOM per-widget "self.*" properties (core/properties.js CUSTOM_CATEGORY):
    // a widget's own declared knobs, grouped in a dedicated "Custom" region
    // (Blender's "Custom Properties" panel) rather than the start-cased fallback.
    custom: "Custom",
    other: "Other",
  };
  const CATEGORY_ORDER = ["positioning", "fillMaterial", "strokeMaterial", "formatting", "effects", "text", "arrow", "lens", "blur", "custom", "other"];

  /** Pure function. Groups plugin inspector rows into ordered category buckets:
   * [{id, title, rows}]. Preserves row order within a category; known
   * categories sort by CATEGORY_ORDER, unknown ones append in first-seen order.
   *
   * Examples:
   *     >>> // rows [{key:"x",category:"positioning"},{key:"fill",category:"fillMaterial"}]
   *     >>> // → [{id:"positioning",title:"Positioning",rows:[…x]},{id:"fillMaterial",…}]
   */
  function groupRows(rows) {
    const buckets = new Map();
    for (const row of rows) {
      const cat = row.category ?? DEFAULT_CATEGORY;
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(row);
    }
    const seen = [...buckets.keys()];
    const ordered = [
      ...CATEGORY_ORDER.filter((c) => buckets.has(c)),
      ...seen.filter((c) => !CATEGORY_ORDER.includes(c)),
    ];
    return ordered.map((id) => ({
      id,
      title: CATEGORY_TITLES[id] ?? (id.charAt(0).toUpperCase() + id.slice(1)),
      rows: buckets.get(id),
    }));
  }

  let itemCategories = $derived(sel ? groupRows(sel.plugin.inspector ?? []) : []);
  let creationCategories = $derived(
    creationState ? groupRows(app.registry.get(creationState.type)?.inspector ?? []) : []
  );

  // Collapsed categories persist as a BROWSER setting (viewer-local; manifest
  // rule for collapse state). ONE map, keyed by category id, shared across item
  // types — collapsing "Positioning" stays collapsed as you switch selections.
  const COLLAPSE_KEY = "powerrp.inspectorCollapsed";
  let collapsed = $state(loadCollapsed());
  function loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn("PowerRP: bad inspectorCollapsed setting, ignoring:", e);
      return {};
    }
  }
  function toggleCategory(id) {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
  }

  // ── Equation discoverability (path tooltip + copy-path) ───────────────────────
  // manifest "EQUATION DISCOVERABILITY — Blender data-path standard": every
  // property row exposes its referencable equation path through the GUI. The
  // label-echo tooltip (hovering a row just repeating its own label) is BANNED
  // as useless ("why not show the path instead") — this replaces it.

  /**
   * Pure function. The row-label tooltip's two-line content: `self.<path>`
   * (valid inside the item's OWN equations) plus, if it differs, the absolute
   * `<slug>.<path>` form (valid from anywhere) on a second line — cheap to
   * show since canonicalPropPath already computes both. Returns null when
   * there's no owning item (transition rows) — those fall back to the label.
   *
   * Examples:
   *     >>> // pathTooltipText({items:{a1:{type:"rect",name:"Box"}}}, "a1", "x")
   *     >>> // → "self.x\nbox.x"
   */
  function pathTooltipText(state, itemId, key) {
    if (itemId == null) return null;
    const { self, absolute } = canonicalPropPath(state, itemId, key);
    return self === absolute ? self : `${self}\n${absolute}`;
  }

  /** Command. Copies the row's ABSOLUTE canonical path (the slug form —
   * paste-ready from anywhere, unlike `self.…` which only resolves inside the
   * item's own equations) to the system clipboard via the shared clipboard
   * helper (web/clipboard.js: secure-context writeText, else an execCommand
   * fallback that works over plain HTTP — the reason the old unguarded
   * navigator.clipboard call threw on a non-localhost origin).
   * ON SUCCESS the button flashes a "Copied!" check (positive feedback, the
   * user's ask); a genuine failure is reported LOUDLY inside the helper and
   * leaves no flash. */
  async function copyPath(state, itemId, key) {
    const { absolute } = canonicalPropPath(state, itemId, key);
    if (await copyText(absolute, "equation path")) {
      justCopiedKey = key;
      setTimeout(() => { if (justCopiedKey === key) justCopiedKey = null; }, COPY_FLASH_MS);
    }
  }

  // ── Value coercion / path read ───────────────────────────────────────────────
  // Color hex parsing/normalization/composition now lives in ColorField.svelte
  // (the SvelteLib ColorPicker owns the picking; ColorField owns the hex round-
  // trip). The old normalizedHex/rgbHex/alphaOf/composedHex/commitHexField and
  // the hexEditing/hexDraft draft state died with the native-input color row.

  function coerce(kind, raw) {
    return kind === "number" ? Number(raw) : kind === "boolean" ? Boolean(raw) : raw;
  }

  /**
   * Pure function. The CANONICAL control kind for a row (core/properties.js
   * ROW_KINDS). A current name passes straight through; a RETIRED spelling maps
   * to its replacement, so a plugin row still carrying the old name gets its
   * REAL control instead of falling through this dispatcher's catch-all text
   * input — which is how a boolean would silently become a text box mid-
   * migration. The alias table is single-sourced in core: deleting an entry
   * there stops that spelling working here, with no edit in this file.
   *
   * @example rowKind({kind: "boolean"}) // "boolean"
   * @example rowKind({kind: "checkbox"}) // "boolean" (retired V1 spelling)
   * @example rowKind({kind: "number"}) // "number"
   */
  function rowKind(row) {
    return RETIRED_ROW_KINDS[row.kind] ?? row.kind;
  }

  /**
   * Query. The element an insert into an EMPTY list row should create: the FIRST
   * element of the owning plugin's own default for that property. It exists
   * because core/lists.insertedElement refuses an empty list — "there is nothing
   * to interpolate from, and the honest answer is for the caller to seed the first
   * element from the property's default" — so this is that caller. Reads the
   * plugin's `defaults`, which is where a default lives (a ROW cannot carry one:
   * core/properties.js row() strips it), the same lookup equationCapable() and
   * NumericField already use. null when there is no selection, no default list, or
   * an empty default.
   */
  function listSeedElement(row) {
    if (sel == null) return null;
    const declared = getPath(sel.plugin.defaults, row.key.split("."));
    return Array.isArray(declared) ? (declared[0] ?? null) : null;
  }

  /**
   * Pure function. Reads a possibly-dotted key ("from.x", "rotationAnchor.x")
   * out of a state object; returns undefined for a missing path. Used to display
   * a row's value from a flat OR nested key uniformly.
   *
   * Examples:
   *     >>> valueAt({from: {x: 3}}, "from.x")
   *     3
   *     >>> valueAt({x: 5}, "x")
   *     5
   *     >>> valueAt({}, "from.x")
   *     undefined
   */
  function valueAt(state, key) {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), state);
  }

  /** Live preview while typing/dragging a field — viewport re-renders in real
   * time BEFORE commit (manifest rule); Enter/blur commits; Escape reverts. */
  function previewField(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) return;
    app.setPreview([[["items", pickedItemId, key], value]]);
  }

  function commitField(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) {
      app.cancelPreview();
      return;
    }
    app.setPreview([[["items", pickedItemId, key], value]]);
    app.commitPreview();
  }

  /** Command. Live preview of a JOINT edit — the multi-selection twin of
   * previewField, for the kinds that commit through the row's generic seam
   * (select / asset / text). The document is untouched until commit. */
  function previewMulti(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) return;
    app.setPreview(fanOutPairs(multiPaths(key), value));
  }

  /** Command. Commits a JOINT edit as ONE undo unit for the whole set
   * (app.unifySelection — which also skips the items already holding the value,
   * and commits nothing at all when none needs writing). */
  function commitMulti(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) {
      app.cancelPreview();
      return;
    }
    app.cancelPreview(); // drop the live preview; the commit re-stages from the document
    app.unifySelection(key, value);
  }

  function fieldKeydown(e) {
    if (e.key === "Escape") {
      app.cancelPreview();
      e.target.blur();
      e.stopPropagation();
    }
  }

  // ── Tier-0 UNIVERSAL "=" equation fallback ──────────────────────────────────
  // manifest "PROPERTY-INTERFACE HIERARCHY": "Tier 0 UNIVERSAL: equation-mode
  // (`=`) on EVERY property, no exceptions… Inspector field-resolution reflects
  // this: pick the specialized editor by slot kind, but ALWAYS allow falling
  // back to the `=` equation field." This is that fallback, in the ONE place the
  // manifest puts it — the row seam — so every kind gets the IDENTICAL
  // affordance rather than five re-inventions.
  //
  // It COPIES NumericField (THE reference implementation): the hover-only ƒ
  // button on the LEFT of the value (app.css .numfield .eq-open), a monospace
  // input with the syntax-highlight overlay behind it, the inline evaluated
  // badge / error affordance, live preview per keystroke, Enter-or-blur commit
  // (ONE undo unit), Escape revert, and the EquationSuggest autocomplete. No new
  // app.css: the markup reuses the .numfield / .eq-* classes verbatim.
  //
  // WHICH KINDS ROUTE HERE: the ones with no equation-aware editor of their own.
  // number (NumericField), angle (AngleField) and paint fill/stroke (PaintField's
  // "= Eq" mode) each own their equation UX already — routing them here would put
  // two competing equation editors on one row. `action` rows (group's Ungroup)
  // are command triggers, not value slots, so they have nothing to bind.
  //
  // WHY HERE AND NOT INSIDE ColorField/BooleanField/AssetField: those fields are
  // also mounted where the value is NOT an equation slot — PaintField renders a
  // ColorField for every gradient STOP color, and core's leaves() keeps array
  // elements opaque to equation detection (PaintField's header: "an EQUATION
  // typed into a stop offset/color is not evaluated"). The Inspector ROW is what
  // knows the value is a real equation slot, so the affordance lives exactly here.
  // NOT "list", deliberately, and it is a KNOWN BOUND rather than a rule: core
  // DOES type a whole list as bindable by reference (core/expressions.js
  // listSlotKind(["points"]) === "list", so `= other.points` evaluates and
  // listResultProblem validates the shape), but this field has no way to SEED
  // one — equationSeed() has no literal form for an array, so opening entry on a
  // list row would offer `=""`, i.e. a string result in a list slot, rejected
  // loudly. The per-ELEMENT `=` the user asked for works through the element
  // fields' own controls inside ListField (a NumericField per coordinate/offset).
  const EQUATION_KINDS = new Set(["color", "boolean", "asset", "select", "text"]);

  // The VISIBLE row's meaning, shared by the two branches that render it (the
  // created-item row's `help`, and the not-yet-created row's label tip) so one
  // property cannot end up explained two different ways.
  const VISIBLE_ROW_HELP =
    "Whether this item shows on THIS slide. It is a keyframeable boolean like any other property — hiding it keyframes active: false here, so the item can appear on some slides and not others.";

  // The one ROW_KIND that is NOT a value slot: it triggers a registry command
  // (core/properties.js "action → a command trigger, not a value slot"). Named
  // rather than spelled inline because three separate decisions key off it — no
  // path chrome, no keyframe diamonds, and a button instead of a field.
  const ACTION_ROW_KIND = "action";
  // Characters of the evaluated value shown in the inline "= …" badge before it
  // is elided — a color hex (9) or a short enum fits; a long string must not
  // push the badge across the whole field.
  const EQ_BADGE_CHARS = 18;

  // The row currently in equation ENTRY from the ƒ button (no equation stored
  // yet), the row whose input holds focus (its draft is live), and that row's
  // state path. Only one row can be edited at a time, so one set of state
  // serves every row — a row that merely STORES an equation renders from the
  // document, not from the draft.
  // eqOwnerId is the ITEM the open entry belongs to: row keys repeat across
  // widgets (nearly every one has "shadow.color"), so without it a selection
  // change while a field is open would reopen that field on the NEW item —
  // showing the old item's draft over a write path pointing at the old item.
  let eqOpenKey = $state(null);
  let eqOwnerId = $state(null);
  let eqFocusKey = $state(null);
  let eqPath = $state(null);
  // THE WRITE TARGETS for the Tier-0 `=` field. `eqPath` above is the PRIMARY
  // path and stays the READ target (the error map, the evaluated badge); this is
  // every selected item's path for the same row, so a multi-selection keeps the
  // universal `=` affordance instead of losing it — Tier 0 says every property is
  // "="-bindable with no exceptions, and a set is not an exception.
  let eqPaths = $state([]);
  let eqDraft = $state("");
  let eqInvalid = $state(false);
  let eqInputEl = $state(null);
  let eqHighlightEl = $state(null);
  let eqSuggestOpen = $state(false);
  let eqHighlighted = $state(0);

  // Autocomplete candidates, re-ranked from the CURRENT caret position on every
  // keystroke (NumericField's rule: the same fragment mid-expression must
  // suggest against the fragment, not the whole draft). `self.` completion
  // resolves against the selected item, which owns every row rendered here.
  let eqCandidates = $derived(
    eqSuggestOpen && eqInputEl
      ? suggestEquation(eqDraft, eqInputEl.selectionStart ?? eqDraft.length, app.rawState(), app.registry, pickedItemId)
      : [],
  );
  $effect(() => {
    if (eqHighlighted >= eqCandidates.length) eqHighlighted = Math.max(0, eqCandidates.length - 1);
  });

  /**
   * Query. Does this row get the Tier-0 `=` fallback? Reads the selection's
   * plugin. Three gates:
   *   - it must be an ITEM row (a transition is per-boundary config and a
   *     grayed not-yet-created row is not editable — neither is an equation
   *     slot core would ever evaluate);
   *   - its kind must have no equation editor of its own (EQUATION_KINDS, and
   *     never a paint row — PaintField owns that one);
   *   - core must be able to TYPE the slot's result. resultKindForSlot reads
   *     the shared property registry, else INFERS the kind from the plugin
   *     default; a key with NEITHER (the inline `active` visibility row, which
   *     no plugin declares) would be typed "string" and a boolean result
   *     rejected — so that row keeps its toggle until core can name its kind.
   */
  function equationCapable(row, itemMode) {
    if (!itemMode || sel == null || pickedItemId == null) return false;
    if (!EQUATION_KINDS.has(rowKind(row)) || row.paint) return false;
    return row.key in PROPS || getPath(sel.plugin.defaults, row.key.split(".")) !== undefined;
  }

  /** Query. The RAW stored value at a row's item path — an `=` string when the
   * row is equation-bound. The specialized editors are handed the EVALUATED
   * state (where an equation has already resolved to a color/boolean/string),
   * so this raw read is the only way to see the equation itself. Mirrors
   * NumericField's stored/evaluated split. */
  function rowStored(row) {
    return getPath(app.rawState(), ["items", pickedItemId, ...row.key.split(".")]);
  }

  /** Query. Is the row SHOWING the equation field — because the document stores
   * an equation there (core's own isEquationValue is the single source of truth
   * for that question), or because the ƒ button just opened entry on THIS row of
   * THIS item (see eqOwnerId)? */
  function equationActive(row, stored) {
    if (eqOpenKey === row.key && eqOwnerId === pickedItemId) return true;
    return isEquationValue(sel.plugin, row.key.split("."), stored);
  }

  /**
   * Pure function. A STORED `=` equation in DISPLAY form: the `=` marker plus
   * core's display form (@itemIds → current slugs, camelCase → snake_case).
   * The marker is split off first because it is NOT part of the expression
   * grammar — storedToDisplay tokenizes what it is given and returns a source
   * it cannot tokenize verbatim, which would leave every @id on screen.
   *
   * @example equationDisplay("=@a1.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "=box.x + 10"
   * @example equationDisplay("=#ff0000", {items: {}}) // "=#ff0000"
   */
  function equationDisplay(stored, state) {
    return `=${storedToDisplay(String(stored).replace(/^\s*=\s*/, ""), state)}`;
  }

  /**
   * Pure function. A typed draft → the STORED equation string: the `=` marker
   * (the universal any-type gate — a property is an equation IFF its string
   * starts with `=`) plus core's stored form (slugs → @itemIds, which is what
   * makes renames free). A leading `=` in the draft is tolerated and re-added,
   * never doubled. Throws (via the parser) on bad syntax or an unknown
   * reference.
   *
   * A REFERENCE-FREE expression skips the display→stored mapping, because it
   * has nothing to map AND because core's token mapper would reject it: the
   * mapper treats the reserved literals `true`/`false` as variable names
   * (`Unknown variable "true"`) even though the parser and evaluator both read
   * them as booleans — so `=true`, the obvious equation for a boolean row,
   * cannot survive displayToStored. compiled() still parses (and throws on)
   * the expression, so nothing is accepted unvalidated. FLAGGED for core: the
   * mapper should skip the boolean literals exactly as parseExpression does.
   *
   * @example equationStored("box.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) // "=@a1.x + 10"
   * @example equationStored("= #ff0000", {items: {}}) // "=#ff0000"
   * @example equationStored("true", {items: {}}) // "=true" (reference-free, mapper bypassed)
   */
  function equationStored(draft, state) {
    const clean = draft.replace(/^\s*=\s*/, "");
    return `=${compiled(clean).refs.length === 0 ? clean : displayToStored(draft, state)}`;
  }

  /**
   * Pure function. The `=` equation that evaluates to `value` — what a row is
   * SEEDED with the moment it enters equation mode, so the field opens on a
   * working expression instead of a blank box (PaintField's `=${seedSolid(raw)}`
   * precedent, generalized to every kind). Booleans and numbers are bare
   * literals, a hex color is a color literal, anything else becomes a quoted
   * string literal escaped EXACTLY as core's tokenizer un-escapes it (\\ and \"
   * only). A structured value (rich text) has no literal form, so it seeds an
   * empty string the user replaces.
   *
   * @example equationSeed(true) // "=true"
   * @example equationSeed("#ff0000") // "=#ff0000"
   * @example equationSeed("multiply") // '="multiply"'
   * @example equationSeed('say "hi"') // '="say \\"hi\\""'
   * @example equationSeed(null) // '=""'
   */
  function equationSeed(value) {
    if (typeof value === "boolean" || typeof value === "number") return `=${value}`;
    if (typeof value === "string" && isHexColor(value)) return `=${value}`;
    const text = typeof value === "string" ? value : "";
    return `="${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  }

  /**
   * Pure function. The evaluated value as inline-badge text, elided past
   * EQ_BADGE_CHARS. A string shows as itself (a color hex reads as a color);
   * every other kind shows its JSON form, so a boolean reads "true"/"false"
   * rather than a coerced blank, and a slot holding nothing reads "null"
   * instead of collapsing into an empty badge.
   *
   * @example equationBadge("#ff0000") // "#ff0000"
   * @example equationBadge(false) // "false"
   * @example equationBadge(undefined) // "null"
   * @example equationBadge("a very long computed caption") // "a very long comput…"
   */
  function equationBadge(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    return text.length > EQ_BADGE_CHARS ? `${text.slice(0, EQ_BADGE_CHARS)}…` : text;
  }

  /**
   * Pure function. Splits equation text into highlight pieces — the `=` marker
   * and whitespace gaps as plain text, every token carrying the class the REAL
   * tokenizer/resolver assigns (never a regex re-lex). MIRRORS NumericField's
   * buildHighlightPieces; the two are one candidate for extraction the day the
   * equation editor becomes its own component.
   *
   * @example equationPieces("=2", {items: {}}, null) // [{text: "=", cls: null}, {text: "2", cls: "num"}]
   */
  function equationPieces(text, state, selfId) {
    const clean = text.replace(/^\s*=\s*/, "");
    const lead = text.slice(0, text.length - clean.length); // the "=" marker (plain)
    const spans = equationTokenSpans(clean, state, selfId);
    const pieces = lead ? [{ text: lead, cls: null }] : [];
    let last = 0;
    for (const s of spans) {
      if (s.start > last) pieces.push({ text: clean.slice(last, s.start), cls: null });
      pieces.push({ text: clean.slice(s.start, s.end), cls: s.cls });
      last = s.end;
    }
    if (last < clean.length) pieces.push({ text: clean.slice(last), cls: null });
    return pieces;
  }

  /** Command (Svelte action). Focuses + selects the equation input of the row
   * that just entered entry from the ƒ button, so the caret lands in the field
   * (NumericField's beginTextEntry does the same). A row rendering because it
   * ALREADY stores an equation is never focus-stolen. */
  function eqAutofocus(node, key) {
    if (eqOpenKey === key) {
      node.focus();
      node.select();
    }
  }

  /** Keeps the highlight overlay's horizontal scroll pinned to the input's, so
   * a long expression that scrolls past the box edge stays under the caret. */
  function syncEqScroll() {
    if (eqHighlightEl && eqInputEl) eqHighlightEl.scrollLeft = eqInputEl.scrollLeft;
  }

  /** Command. Enters equation mode on a row that holds a LITERAL: seeds the
   * draft with an equation evaluating to the current value and opens the input
   * (nothing is written until commit). */
  function beginEquation(row, paths) {
    eqOpenKey = row.key;
    eqOwnerId = pickedItemId;
    eqFocusKey = row.key;
    eqPath = paths[0];
    eqPaths = paths;
    eqDraft = equationSeed(getPath(app.state(), path));
    eqInvalid = false;
    eqSuggestOpen = false;
  }

  /** Command. Leaves equation mode: commits the CURRENT EVALUATED value as a
   * plain literal (ONE undo unit), so the specialized editor comes back holding
   * exactly what the equation last produced. The evaluated value is right-typed
   * by construction — core validates an equation's result against the slot kind
   * and falls back to the plugin default on a mismatch — so this never writes a
   * coerced string where a color/boolean belongs. */
  function dropEquation(paths) {
    // The literal comes from the PRIMARY's evaluated value and is written to all
    // of them, which is the same UNIFY semantics leaving equation mode has to
    // have: one row, one value.
    app.setPreview(fanOutPairs(paths, getPath(app.state(), paths[0])));
    app.commitPreview();
    eqOpenKey = null;
    eqOwnerId = null;
    eqFocusKey = null;
    eqDraft = "";
    eqInvalid = false;
    eqSuggestOpen = false;
  }

  /** Command. Takes over the shared draft when an equation input gains focus
   * (from the ƒ button, a click, or Tab) and captures the elements the caret
   * math needs. The overlay is found relative to the input because BOTH are
   * rendered per row: one shared bind:this would point at whichever row mounted
   * last, not the one being edited. */
  function onEqFocus(e, row, paths, stored) {
    eqOwnerId = pickedItemId;
    eqInputEl = e.target;
    eqHighlightEl = e.target.parentElement.querySelector(".eq-highlight");
    if (eqFocusKey !== row.key && eqOpenKey !== row.key) eqDraft = equationDisplay(stored, app.rawState());
    eqFocusKey = row.key;
    eqPath = paths[0];
    eqPaths = paths;
  }

  /** Command. Live-previews the draft (the viewport re-renders mid-typing, the
   * document is untouched) and re-ranks the autocomplete. */
  function onEqInput(e) {
    eqDraft = e.target.value;
    eqSuggestOpen = true;
    eqHighlighted = 0;
    syncEqScroll();
    try {
      app.setPreview(fanOutPairs(eqPaths, equationStored(eqDraft, app.rawState())));
      eqInvalid = false;
    } catch {
      // Invalid draft: the invalid affordance IS the report — a specific message
      // would thrash while typing, and commit reports loudly if the user insists
      // (NumericField's ruling, copied so both fields behave identically).
      app.cancelPreview();
      eqInvalid = true;
    }
  }

  /** Command. Replaces the in-progress fragment with the accepted candidate and
   * re-previews — it does NOT commit (the user is still editing) and never moves
   * focus out of the input. */
  function acceptEqCandidate(candidate) {
    if (!candidate || !eqInputEl) return;
    const { text, cursor } = acceptSuggestion(eqDraft, eqInputEl.selectionStart ?? eqDraft.length, candidate.text);
    eqDraft = text;
    eqSuggestOpen = false;
    try {
      app.setPreview(fanOutPairs(eqPaths, equationStored(eqDraft, app.rawState())));
      eqInvalid = false;
    } catch {
      app.cancelPreview();
      eqInvalid = true;
    }
    requestAnimationFrame(() => eqInputEl?.setSelectionRange(cursor, cursor));
    eqInputEl.focus();
  }

  /** Command. Reverts the live preview and leaves entry without writing. A row
   * that already STORES an equation keeps it (and keeps rendering as one). */
  function cancelEquation() {
    app.cancelPreview();
    eqOpenKey = null;
    eqOwnerId = null;
    eqFocusKey = null;
    eqInvalid = false;
    eqSuggestOpen = false;
    eqDraft = "";
  }

  /** Command. Commits the draft as the row's `=` equation — ONE undo unit,
   * keyframed on the current slide like any other property write. An empty
   * draft writes nothing (deleting the text is not a value); a draft that will
   * not parse or resolve is reported LOUDLY and reverted, never stored as a
   * literal string that would silently become garbage in a color/boolean slot
   * (the ƒ button is the explicit way back to a literal). */
  function commitEquation() {
    eqSuggestOpen = false;
    if (eqDraft.replace(/^\s*=\s*/, "").trim() === "") {
      cancelEquation();
      return;
    }
    let stored;
    try {
      stored = equationStored(eqDraft, app.rawState());
    } catch (e) {
      console.error(`PowerRP: equation not committed: ${e.message}`);
      cancelEquation();
      return;
    }
    app.setPreview(fanOutPairs(eqPaths, stored));
    app.commitPreview();
    eqOpenKey = null;
    eqOwnerId = null;
    eqFocusKey = null;
    eqInvalid = false;
  }

  /** Keyboard for the equation input, autocomplete-aware — NumericField's
   * handler, unchanged in behavior:
   *   Up/Down    move the suggestion highlight (only while open)
   *   Tab/Enter  accept the highlighted suggestion while the list is open;
   *              Enter with it closed commits the field
   *   Escape     dismisses an OPEN list first (field untouched); a second
   *              Escape reverts the field. */
  function onEqKeydown(e) {
    const hasSuggestions = eqSuggestOpen && eqCandidates.length > 0;
    if (hasSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      eqHighlighted = (eqHighlighted + (e.key === "ArrowDown" ? 1 : -1) + eqCandidates.length) % eqCandidates.length;
      e.preventDefault();
    } else if (hasSuggestions && (e.key === "Tab" || e.key === "Enter")) {
      acceptEqCandidate(eqCandidates[eqHighlighted]);
      e.preventDefault();
    } else if (e.key === "Enter") {
      commitEquation();
      e.target.blur();
    } else if (e.key === "Escape" && hasSuggestions) {
      eqSuggestOpen = false;
      e.stopPropagation(); // dismiss-only: don't bubble into Deselect
    } else if (e.key === "Escape") {
      cancelEquation();
      e.target.blur();
      e.stopPropagation();
    }
  }

  /** Blur commits, but only when there is something to commit: an untouched
   * draft (clicking the ƒ button to drop the equation, or tabbing away) must
   * not spend an undo unit re-writing the same string. */
  function onEqBlur(row, stored) {
    const opened = eqOpenKey === row.key;
    eqFocusKey = null;
    eqSuggestOpen = false;
    if (eqInvalid || opened || eqDraft !== equationDisplay(stored, app.rawState())) commitEquation();
  }

  // (keyframe insert/remove/jump for property rows now lives in the shared
  // KeyframeControls component — see the propRow snippet.)

  // ── Visibility (the `active` boolean row) + Purge gating ────────────────────
  // Whether Purge / the visibility row show at all — the camera
  // (purgeable:false) is mandatory (always exactly one) and shows neither. Works
  // for both a created item (sel.plugin) and a not-yet-created one (its type
  // comes from the creation-fold state).
  let purgeable = $derived.by(() => {
    const type = sel?.type ?? creationState?.type;
    if (type == null) return false;
    return app.registry.get(type)?.capabilities.purgeable !== false;
  });

  /** Toggles visibility of a CREATED item on this slide: keyframes `active`
   * true/false (upsert), one undo unit; keeps the selection so a hidden item
   * (red picker row) toggles right back. This IS the boolean-property row's
   * write — the row's BooleanField calls setPreview/commitPreview on
   * ["items", id, "active"]; the visible-item path needs nothing special. */

  /** Activates a NOT-YET-CREATED item on THIS slide (manifest Round 12B, lead
   * ruling): writes the item's FOLDED STATE AS OF ITS ORIGINAL CREATION SLIDE
   * (its full property set — NOT bare plugin defaults, so it appears "looking
   * like itself") plus active:true, as keyframes on the CURRENT slide, in ONE
   * undo unit. This makes the current slide the new EFFECTIVE creation slide;
   * the original creation slide's keyframes remain (idempotent re-writes). The
   * write path degrades gracefully into the queued slide-0-defaults architecture
   * (there, activation becomes a bare active:true because defaults live at slide
   * 0). Only the ON action is meaningful pre-creation (the row shows OFF). */
  function activateNotYetCreated() {
    if (!creationState) return;
    app.setPreview([[["items", pickedItemId], { ...creationState, active: true }]]);
    app.commitPreview();
  }

  // ── Transitions (the agreed cross-target seam; Opus9's app-side API) ─────────
  // A transition target renders the incoming slide boundary's config through the
  // SAME generic row machinery — but WITHOUT keyframe diamonds (a transition is
  // per-boundary CONFIG, not keyframable tweened state). The type registry lives
  // in core/transitions.js (transitionInspector/TRANSITION_TYPES); the folded
  // record + writes come from the app accessors (transitionAt/setTransitionProp/
  // setTransitionType).
  let transitionSlideId = $derived(target?.kind === "transition" ? target.slideId : null);
  let transitionState = $derived(
    transitionSlideId != null ? app.transitionAt(transitionSlideId) : null
  );
  // Row defs = the type's full inspector (superclass seconds/curve/sound +
  // type extras), grouped like item rows (they carry a "transition" category).
  let transitionCategories = $derived(
    transitionState ? groupRows(transitionInspector(transitionState.type)) : []
  );
  // The type dropdown lists every registered transition type (tween|fade|…).
  let transitionTypeChoices = TRANSITION_TYPES.map((t) => ({ value: t.type, label: t.title }));

  /** Commits one transition property (per-boundary config; one undo unit via the
   * app accessor). Not keyframed/previewed — transitions have no tween state. */
  function commitTransition(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) return;
    app.setTransitionProp(transitionSlideId, key, value);
  }
</script>

<!-- Picker row adapter: items flagged `invisible` (not visible on the current
     slide) render in the danger red — the signal that selecting them shows
     state without a canvas presence. Visible rows render exactly as before. -->
{#snippet pickerItem(it)}
  <span class:picker-invisible={it.invisible}>{it.label}</span>
{/snippet}

<!-- ONE generic property row: label + control-by-kind + optional keyframe
     controls. Consumed by item categories (keyframes: true) AND transition rows
     (keyframes: false — transitions are config, not keyframable). When
     `disabled` the row is grayed and non-interactive (a not-yet-created item's
     display rows); `state` supplies the display values, `onpreview`/`oncommit`
     the write path (item rows write items[id].key; transition rows write
     transition props); `itemId` (null for transitions — they have no equation
     path) + `pathState` (the state canonicalPropPath resolves the item's slug
     against — usually `state` itself, but the not-yet-created path needs a
     synthetic {items:{id: creationState}} shape since app.rawState() doesn't
     fold an item that doesn't exist on this slide) drive the row-label PATH
     tooltip + copy-path chrome (manifest "EQUATION DISCOVERABILITY").

     `hoverPreview` is OPT-IN and DELIBERATELY SEPARATE from `onpreview`: a select
     row previews the option the pointer/arrow-keys are merely CONSIDERING, and
     for a keyframable item row that is `previewField` (setPreview — document
     untouched, no undo entry). It cannot reuse `onpreview`, because in the
     TRANSITION context `onpreview` IS `commitTransition` (transitions have no
     tween state, so their preview and commit are the same write) — wiring hover
     to it would COMMIT A TRANSITION TYPE ON HOVER. So the two created-item call
     sites opt in by name and the transition/not-yet-created ones simply do not.
     null (the default) = no hover preview, exactly as before. -->
{#snippet propRow(row, state, { keyframes = true, disabled = false, onpreview, oncommit, itemId = null, pathState = null, hoverPreview = null, multi = null })}
  <!-- ITEM MODE (keyframes && !disabled): equation-aware NumericField + keyframe
       diamonds, writing item property keyframes. Otherwise PLAIN MODE: a not-yet-
       created item's grayed display (disabled) or a transition's config rows
       (keyframes:false) — plain inputs committing directly via onpreview/oncommit,
       no equations, no diamonds. -->
  {@const itemMode = keyframes && !disabled}
  <!-- An ACTION row is a command trigger, not a property: it owns no state, so
       it has no equation path to copy and nothing to keyframe. Both affordances
       are withheld here rather than inside valueControl, because both live in
       THIS snippet's grid cells. -->
  {@const isAction = rowKind(row) === ACTION_ROW_KIND}
  {@const pathText = isAction ? null : pathTooltipText(pathState ?? state, itemId, row.key)}
  {@const helpText = row.help ?? null}
  <!-- DYNAMIC BOUNDS (general mechanism): a row's `max` may be a STATE-DERIVED
       FUNCTION `(state) => number` (e.g. pdf_page's page cap = pageCount for the
       current src), not just a static number. Resolved here so the numeric field
       still receives a plain number; `null` = unbounded. Static numbers pass
       through unchanged. Extend to `min` the same way if a widget ever needs it. -->
  {@const resolvedMax = typeof row.max === "function" ? row.max(state) : (row.max ?? null)}
  <!-- MULTI-SELECTION (core/multiselect.js). `multi` is this row's set state —
       {row, mixed, value, seed, problem} — and `writePaths` is every selected
       item's path for it. THE FIELDS ARE NOT FORKED: each Tier-1 field takes the
       same singular `path` it always did (the PRIMARY, which an unmixed row means
       every item agrees with) plus `paths` for the WRITE. Reusing the itemMode
       branch is deliberate: this pipeline has already shipped a bug where a
       declared row aspect was silently ignored because a SIBLING branch never
       threaded it, and a third "multi" branch would reproduce that for every
       aspect at once. -->
  <!-- `multi` is the CONTEXT flag (one options object serves a whole category);
       this row's own set state is looked up by key, so there is no per-row options
       object to build and nothing to keep in step. -->
  {@const multiRow = multi ? multiByKey.get(row.key) : null}
  {@const writePaths = multi ? multiPaths(row.key) : null}
  {@const ctx = { itemMode, disabled, onpreview, oncommit, itemId, resolvedMax, hoverPreview, writePaths }}
  <!-- TIER 0 (manifest field-resolution rule): does this row get the universal
       `=` fallback, is it showing it, and what does it actually STORE (the raw
       value — the specialized editors receive the EVALUATED one, where an
       equation has already resolved to a color/boolean/string). -->
  {@const eqCapable = equationCapable(row, itemMode)}
  {@const eqStored = eqCapable ? rowStored(row) : null}
  {@const eqActive = eqCapable && equationActive(row, eqStored)}
  {@const eqRowPaths = eqCapable ? (multi ? multiPaths(row.key) : [["items", pickedItemId, ...row.key.split(".")]]) : null}
  <!-- A LIST row (core/lists.js) keeps the label + keyframe line in the shared
       grid but gives the LIST ITSELF the panel's full width on a second line: one
       element row carries an index, a visibility eye, several field controls, the
       keyframe triad and a purge button, which does not fit the single value cell
       a scalar row uses. app.css .row-list places the two lines; nothing else
       about the row changes. -->
  <div class="row" class:row-disabled={disabled} class:row-list={rowKind(row) === LIST_ROW_KIND}>
    <!-- Row-label hover chrome: PATH tooltip on the LABEL (never a label echo
         — banned) + two LEFT-side hover-only icons (round-11 field-chrome
         precedent — .numfield .eq-open mirrors the same idiom on the value
         side: zero-width/opacity at rest, revealed by .row:hover, so revealing
         them never nudges the fixed label column or the value edges):
           • copy-path — copies the row's canonical equation path (needs an
             owning item; absent on transition rows).
           • (?) help  — shows the property's descriptive help via Tooltip
             (immediate, follows the cursor) when the row def carries `help`
             (manifest "property help tooltips"; text lives on the shared
             property registry, inherited by every widget). Its tooltip is the
             MEANING; the label's is the PATH — they coexist without fighting
             (different anchors: (?) button vs. label span).
         The chrome renders when EITHER affordance applies; each button gates
         on its own condition, so a row with help-but-no-path (a transition
         row) still gets the (?), and a row with path-but-no-help still gets
         copy. A row with neither falls back to a plain label span (no echo
         tooltip — banned). -->
    {#if pathText != null || helpText != null}
      <span class="row-label-chrome">
        {#if pathText != null}
          {@const copied = justCopiedKey === row.key}
          <Tooltip text={copied ? "Copied!" : "Copy equation path"}>
            <button
              class="copy-path-btn"
              aria-label={copied ? `Copied path for ${row.label}` : `Copy equation path for ${row.label}`}
              onclick={() => copyPath(pathState ?? state, itemId, row.key)}
            >
              <iconify-icon icon={copied ? "mdi:check" : "mdi:content-copy"} width="12" height="12"></iconify-icon>
            </button>
          </Tooltip>
        {/if}
        {#if helpText != null}
          <Tooltip text={helpText}>
            <button class="help-btn" aria-label={`Help: ${row.label}`}>
              <iconify-icon icon="mdi:help-circle-outline" width="13" height="13"></iconify-icon>
            </button>
          </Tooltip>
        {/if}
        {#if pathText != null}
          <Tooltip placement="top">
            {#snippet tip()}
              {#each pathText.split("\n") as line}<div class="path-tip-line">{line}</div>{/each}
            {/snippet}
            <span class="label">{row.label}</span>
          </Tooltip>
        {:else}
          <span class="label">{row.label}</span>
        {/if}
      </span>
    {:else}
      <span class="label">{row.label}</span>
    {/if}
    <!-- THE TIERED VALUE CELL. Tier 1 is the specialized editor; Tier 0 is the
         universal `=` field that can always stand in for it. Both live inside
         .numfield — the equation-aware field chrome NumericField already owns in
         app.css (hover-only ƒ on the LEFT of the value, highlighted monospace
         input, inline evaluated badge). Reusing that chrome verbatim is what
         makes a color row's equation affordance pixel-identical to a number's.
         A row with no equation fallback (number/angle/paint, which own theirs;
         transition + grayed rows, which are not equation slots) renders the
         specialized editor alone, exactly as before. -->
    {#if multiRow?.problem}
      <!-- SHARED BUT NOT JOINTLY EDITABLE. Listed, inert, and EXPLAINING ITSELF
           (the "a disabled control explains itself" rule, and the standing
           Inspector rule that a row which cannot be edited in this context is
           still rendered grayed rather than omitted — omitting it would misreport
           what the items have in common). -->
      <Tooltip text={multiRow.problem}>
        <span class="mixed-blocked">{MIXED_MARK}</span>
      </Tooltip>
    {:else if multiRow?.mixed}
      <!-- MIXED. The user's spec: "a dot dot dot in the parts that are different.
           And then when I click them, it would have to unify them all to the same
           value." The mark sits IN the value cell — the field's own footprint —
           rather than as an extra button beside it, because a per-field mode
           BUTTON was built once and vetoed. One click unifies (ONE undo unit) and
           the real field takes over, already editing all N together. -->
      <Tooltip text={`${multiPanel.itemIds.length} selected items differ here — click to set them all to ${multiValueLabel(multiRow.seed)}`}>
        <button class="mixed-unify" aria-label={`${row.label}: differs across the selection — unify to ${multiValueLabel(multiRow.seed)}`} onclick={() => unifyRow(multiRow)}>
          {MIXED_MARK}
        </button>
      </Tooltip>
    {:else if eqCapable}
      <div class="numfield">
        {@render eqToggle(row, eqRowPaths, eqActive)}
        {#if eqActive}
          {@render equationEntry(row, eqRowPaths, eqStored)}
        {:else}
          {@render valueControl(row, state, ctx)}
        {/if}
      </div>
    {:else}
      {@render valueControl(row, state, ctx)}
    {/if}
    <!-- prev ◆ next — the shared KeyframeControls (jumps hug the diamond;
         hollow = not keyed on this slide, filled = keyed). Grouped in ONE
         .kf-controls span so they occupy a SINGLE grid cell (the row grid's
         trailing auto column). Dotted item keys (arrow "from.x") split into the
         full ["items", id, ...] path. Transitions and grayed rows have no
         diamonds; the empty span still reserves the column so value edges stay
         aligned. -->
    {#if keyframes && !disabled && !isAction}
      <span class="kf-controls">
        <KeyframeControls {app} path={["items", itemId, ...row.key.split(".")]} paths={writePaths} />
      </span>
    {:else}
      <span class="kf-controls" aria-hidden="true"></span>
    {/if}
  </div>
{/snippet}

<!-- THE TIER-1 SPECIALIZED CONTROL for one row, chosen by slot kind. Split out
     of propRow so the Tier-0 `=` equation fallback can stand in FRONT of it for
     every kind without the two dispatches interleaving. `ctx` carries what
     propRow already resolved: itemMode/disabled (which presentation), the
     onpreview/oncommit write pair, the owning itemId, and the resolved dynamic
     max. Unchanged from when it lived inline in propRow. -->
{#snippet valueControl(row, state, ctx)}
  {@const itemMode = ctx.itemMode}
  {@const disabled = ctx.disabled}
  {@const onpreview = ctx.onpreview}
  {@const oncommit = ctx.oncommit}
  {@const itemId = ctx.itemId}
  {@const resolvedMax = ctx.resolvedMax}
  {@const hoverPreview = ctx.hoverPreview}
  <!-- null for a single selection, so every field below receives `paths={null}`
       and behaves byte-identically to before. -->
  {@const writePaths = ctx.writePaths}
  <!-- Branch on the CANONICAL kind (rowKind), never row.kind: a row still
       carrying a retired spelling must reach the same control as the current
       one, or the two spellings render as two different things — which is
       exactly the drift this dispatcher exists to prevent. -->
  {@const kind = rowKind(row)}
  {#if kind === ACTION_ROW_KIND}
    <!-- A COMMAND TRIGGER, not a value slot (core/properties.js: `action` → "a
         command trigger, not a value slot"). Before this branch existed, an
         action row fell through to the catch-all text `<input>` at the bottom of
         this dispatcher: "Ungroup" rendered as an empty editable field that gave
         no sign it was a button, and typing in it keyframed a junk `__ungroup`
         string onto the item. So this is an EXPLANATION fix first and a
         correctness fix second.

         aria-disabled, NOT the native `disabled` attribute — the CommandPalette
         precedent, but for a MEASURED reason rather than the one written there:
         pointer events DO reach a natively disabled button in Chrome (so its
         tooltip does show), but a natively disabled button is NOT FOCUSABLE, so
         the keyboard could never reach the sentence saying why it is dead. The
         guard therefore lives in the handler, exactly as the palette's
         activate() does. -->
    {@const entry = app.commands.get(row.command)}
    {@const reason = disabled ? "a widget that exists on this slide" : commandUnavailableReason(entry, app)}
    <!-- The tip is the command's HELP — what the click does to the document —
         never its title, which the button's own label already shows. Falling back
         to `entry.title` would ship the label echo this file bans ("hovering a row
         just repeating its own label is BANNED as useless"), which is exactly what
         the first version of this branch did: the Ungroup tip read "Ungroup". -->
    <Tooltip>
      {#snippet tip()}
        {#if row.help ?? entry.help}<div>{row.help ?? entry.help}</div>{/if}
        <!-- The WHY beneath the what, rendered only while it is actually
             unavailable so it reads as the live reason and not a standing
             caveat — the Toolbar / Tools pane / palette wording and class. -->
        {#if reason}<div class="tool-tip-requires">Unavailable — requires {reason}</div>{/if}
      {/snippet}
      <button
        class="btn"
        aria-disabled={reason != null}
        onclick={() => { if (reason == null) app.runCommand(row.command); }}
      >
        {#if entry.icon}<iconify-icon icon={entry.icon} width="16" height="16"></iconify-icon>{/if}
        {row.label}
      </button>
    </Tooltip>
  {:else if kind === "number"}
    {#if itemMode}
      <!-- NumericField: equation-aware (THE UNIFICATION). A number renders as
           the DraggableNumber scrubber; an equation as a monospace expression
           editor with live evaluation + error affordance. Click-without-drag
           opens text entry; typed content decides number vs equation.
           `display` (e.g. "degrees") edits/shows in a unit different from
           storage. Dotted keys ("from.x") = nested state.

           NO `defaultValue` IS PASSED, and that is not an omission: a row cannot
           carry a default (core/properties.js `row()` strips it, `customProps()`
           moves it into the plugin's defaults), so `row.default ?? null` was null
           at every one of the 1507 numeric rows. NumericField reads the default
           from the owning plugin instead — the same `sel.plugin.defaults` lookup
           equationCapable() above already uses. -->
      <NumericField
        {app}
        path={["items", pickedItemId, ...row.key.split(".")]}
        paths={writePaths}
        label={row.label}
        min={row.min ?? null}
        max={resolvedMax}
        display={row.display ?? null}
        scrub={row.scrub ?? null}
        step={row.step ?? null}
      />
    {:else if disabled}
      <!-- Grayed display of a not-yet-created item: read the value straight
           from the creation-fold state; no equation/scrub affordance. -->
      <input type="text" class="disabled-val" value={String(valueAt(state, row.key) ?? "")} disabled />
    {:else}
      <!-- Plain number (transition config): a bounded DraggableNumber scrubber
           that commits directly (no equations, no keyframes). THREADS the row's
           `scrub` coefficient (manifest 14.6): a transition-seconds row carries
           SECONDS_SCRUB from the property registry, so a full 100px drag spans
           ~1s instead of 100s. Without this the plain scrubber fell back to
           DraggableNumber's 1 unit/px default — the reason the Round-12
           `scrub: 0.1` fix never reached the transition seconds row (it was only
           threaded through the ITEM NumericField path above, never this one).
           The item path scales bounded rows across a pixel run in NumericField;
           here (an unbounded seconds row) the explicit coefficient IS the fix,
           so pass row.scrub straight through when present.

           `defaultValue` is likewise NOT passed (it too was `row.default ?? null`,
           i.e. always null — see the item branch above). Here it would be inert
           even if a row could carry one: DraggableNumber uses defaultValue only to
           DERIVE a step, and the sole numeric row that reaches this branch
           (core/transitions.js `row("seconds")`) declares an explicit `scrub`,
           which outranks any default. A transition's own default seconds lives
           with the transition TYPE, the analogue of a plugin's `defaults`. -->
      <div class="numfield">
        <DraggableNumber
          label={row.label}
          value={Number(valueAt(state, row.key) ?? 0)}
          min={row.min ?? null}
          max={resolvedMax}
          coefficient={row.scrub ?? 1}
          oninput={(n) => onpreview(row.key, kind, n)}
          onchange={(n) => oncommit(row.key, kind, n)}
        />
      </div>
    {/if}
  {:else if kind === "select"}
    <!-- Enum dropdown (transition `curve`, widget enums like blendMode, and the
         optionsFrom:"items" widget pickers). SvelteLib Dropdown over the row's
         `options`, filling the value column — a FIXED option set with no free
         text, which is exactly why an item row's select also carries the ƒ
         equation escape hatch beside it (the Dropdown itself is untouched).
         Dropdown has no top-level disabled prop, so a future disabled select
         would render the plain grayed value instead.

         HOVER/ARROW-KEY LIVE PREVIEW: the Dropdown reports which row is ACTIVE
         (pointer OR keyboard — one notion, so both preview identically) and this
         row previews it, so an enum shows what it WOULD look like before you pick
         it. That is the same live-preview contract every other control here obeys
         (viewport re-renders, document untouched, no undo entry) — closing or
         Escaping reverts via cancelPreview, and only a real click/Enter reaches
         `oncommit` for its ONE undo unit.
         Wired ONLY when the row's context opted in (ctx.hoverPreview) — see the
         propRow header for why a transition row must never get it.

         GROUPED OPTIONS: a row that declares `optionGroups` (blendMode's six
         families) gets a caption row ahead of each family, built by
         core/properties.js selectRowItems from the SAME declaration the option
         order is flattened from. Captions are Dropdown `insert` entries, so they
         are unselectable, skipped by the arrow keys, and never previewed. -->
    <Dropdown
      onpreview={hoverPreview ? (v) => hoverPreview(row.key, "select", v) : undefined}
      oncancelpreview={hoverPreview ? () => app.cancelPreview() : undefined}
      items={row.optionsFrom === "items"
        ? allDocumentItems(app.doc)
            .filter((it) => it.id !== itemId && app.registry.get(it.type)?.capabilities.purgeable !== false)
            .map((it) => ({ value: it.id, label: it.name ?? itemFallbackName(app.registry.get(it.type).title, it.id) }))
        : selectRowItems(row)}
      value={valueAt(state, row.key)}
      onchange={(v) => oncommit(row.key, "select", v)}
    />
  {:else if kind === "asset"}
    <!-- THE asset control (manifest "ASSET UX ROUND 2"): AssetField — current
         name + Browse (picker modal, Asset Explorer's tile grid, filtered to
         row.assetKinds) + Upload, drag-and-drop from the Asset Explorer AND
         Finder. ONE commit per pick/upload/drop (an asset pick is atomic —
         no live-preview gesture, unlike a numeric drag) via the row's
         `oncommit(key, kind, value)` — the SAME call every other plain-mode
         kind (select) uses, so item rows write a keyframe and transition
         rows write transition config with zero branching here (oncommit IS
         commitField for items, commitTransition for transitions — both
         already perform exactly one write). -->
    <AssetField
      {app}
      value={valueAt(state, row.key)}
      label={row.label}
      assetKinds={row.assetKinds ?? ["image"]}
      assetForm={row.assetForm ?? "url"}
      nullable={row.nullable ?? false}
      {disabled}
      oncommit={(v) => oncommit(row.key, "asset", v)}
      autoOpen={row.key === "src" && app.pendingVideoPickFor === pickedItemId}
      onpickerclose={() => { if (app.pendingVideoPickFor === pickedItemId) app.pendingVideoPickFor = null; }}
    />
  {:else if kind === "angle"}
    <!-- THE angle control (kind:"angle"): AngleField — a rotary DIAL (+ typed
         degrees) that self-writes to this item path, exactly like ColorField
         (preview mid-drag, commit on release; the row's shared KeyframeControls
         keyframe it like any other property). `disabled` grays a not-yet-created
         item's row.
         `display` is threaded exactly as the number branch threads it: the dial
         shows degrees, the row says what it STORES (`rotation` stores radians).
         NO Number() coercion on `value` — the same coercion class of bug that
         silently turned an equation into 0. The field takes the evaluated value
         raw (in stored units) and parks at 0° with the error badge showing if it
         is not a finite heading. -->
    <AngleField
      {app}
      path={["items", pickedItemId, ...row.key.split(".")]}
      paths={writePaths}
      label={row.label}
      value={valueAt(state, row.key)}
      display={row.display ?? null}
      disabled={disabled}
    />
  {:else if kind === "color" && row.paint}
    <!-- PAINT rows (fill/stroke — Axis-1): PaintField edits a polymorphic paint
         (solid | linear/radial gradient). A solid delegates to ColorField
         verbatim (byte-identical to before); a gradient stores a {type,stops,
         geometry} object at the SAME item path. Same commit contract. -->
    <PaintField
      {app}
      path={["items", pickedItemId, ...row.key.split(".")]}
      paths={writePaths}
      label={row.label}
      value={valueAt(state, row.key)}
      disabled={disabled}
      strokeMaterials={row.key === "stroke"}
    />
  {:else if kind === "color"}
    <!-- THE color control: the SvelteLib ColorPicker (integral alpha) wrapped
         in ColorField — a compact swatch + hex readout that inline-expands the
         full picker on click. Alpha is integral (not a bolted-on field); the
         native <input type=color> is GONE. Live semantics: picker oninput →
         preview (viewport re-renders mid-gesture, doc unchanged), onchange →
         commit (one undo unit); Escape while open reverts + closes; no Enter.
         Storage stays #rrggbbaa (opaque collapses to #rrggbb); legacy #rrggbb
         loads as opaque. Only item rows are colors (no transition color rows),
         so the path is always ["items", pickedItemId, …]; a grayed not-yet-
         created item passes disabled to block interaction. Unlike a number a
         color has no equation split, so itemMode/plain collapse to one call. -->
    <ColorField
      {app}
      path={["items", pickedItemId, ...row.key.split(".")]}
      paths={writePaths}
      label={row.label}
      value={valueAt(state, row.key)}
      disabled={disabled}
    />
  {:else if kind === LIST_ROW_KIND}
    <!-- LIST rows (core/lists.js): a variable-length list of multi-field
         elements — a polygon's `points`, and (through PaintField) a gradient's
         `stops`. ListField is driven ENTIRELY by the declaration the ROW ITSELF
         carries (element fields + kinds, order flavour, visibility companion key,
         length floor), so `row` IS the `decl` — there is no second table to keep
         in step, and the next list property needs no code here.

         THIS BRANCH IS LOAD-BEARING FOR SAFETY, not just for looks: without it a
         list row fell through to this dispatcher's catch-all TEXT input, whose
         oninput would commit a STRING over the element array — a crashed
         renderer, and the reason no list row could be declared before now. The
         `.list-cell` wrapper is what app.css .row-list places on the row's
         second line (a component root cannot be grid-placed from outside). -->
    <span class="list-cell">
      <ListField
        {app}
        decl={row}
        path={["items", pickedItemId, ...row.key.split(".")]}
        label={row.label}
        {disabled}
        seedElement={listSeedElement(row)}
      />
    </span>
  {:else if kind === "boolean"}
    {#if itemMode}
      <!-- Standard boolean control (BooleanField): a square toggle whose state
           shows via the icon (never a background fill — toggle ruling). Used for
           `active` (visibility) and plugin booleans like `bold`. Writes an item
           property keyframe on this slide. -->
      <BooleanField
        {app}
        path={["items", pickedItemId, ...row.key.split(".")]}
        paths={writePaths}
        label={row.label}
        value={row.key === "active" ? state.active !== false : Boolean(valueAt(state, row.key))}
        onIcon={row.onIcon}
        offIcon={row.offIcon}
        onText={row.onText}
        offText={row.offText}
        {disabled}
      />
    {:else}
      <!-- Plain boolean (grayed item display / transition config): a simple
           toggle committing directly (no keyframe path). -->
      <div class="boolfield">
        <button
          class="boolbtn"
          class:on={Boolean(valueAt(state, row.key))}
          aria-label={row.label}
          aria-pressed={Boolean(valueAt(state, row.key))}
          {disabled}
          onclick={() => oncommit(row.key, "boolean", !valueAt(state, row.key))}
        >
          <iconify-icon icon={valueAt(state, row.key) ? (row.onIcon ?? "mdi:check") : (row.offIcon ?? "mdi:checkbox-blank-outline")} width="16" height="16"></iconify-icon>
        </button>
      </div>
    {/if}
  {:else}
    <input
      type="text"
      value={state[row.key] ?? ""}
      {disabled}
      oninput={(e) => onpreview(row.key, kind, e.target.value)}
      onchange={(e) => oncommit(row.key, kind, e.target.value)}
      onkeydown={fieldKeydown}
    />
  {/if}
{/snippet}

<!-- THE ƒ AFFORDANCE — the same control NumericField puts on the left of a
     numeric value (app.css .numfield .eq-open: hover-only, zero width at rest,
     revealed by .row:hover or focus-within, so the resting row is just label +
     value). Here it TOGGLES, because a non-numeric kind has no "just type a
     literal" way back the way a number does: pressed = the row is an equation,
     and clicking it drops back to the evaluated value as a plain literal. That
     is PaintField's Solid↔"= Eq" mode switch, expressed with NumericField's
     button so there is ONE recognizable way in and out of equation mode. -->
{#snippet eqToggle(row, paths, active)}
  <Tooltip text={active ? "Drop the equation, keeping its current value" : "Enter an equation"}>
    <button
      class="eq-open"
      aria-label={active ? `${row.label}: drop the equation` : `${row.label}: enter an equation`}
      aria-pressed={active}
      onclick={() => (active ? dropEquation(paths) : beginEquation(row, paths))}
    >
      <iconify-icon icon="mdi:function-variant" width="14" height="14"></iconify-icon>
    </button>
  </Tooltip>
{/snippet}

<!-- THE UNIVERSAL `=` FIELD (Tier 0) — NumericField's equation mode, verbatim in
     structure: a colorized overlay painted BEHIND a transparent-text input (the
     input owns the caret and selection, so text behavior stays 100% native), the
     inline evaluated badge pinned inside the right edge, the error affordance
     carrying the derivation stage's message, and the EquationSuggest dropdown
     anchored under the field. The value shown is the DISPLAY form (slugs); the
     document stores @itemIds behind the `=` marker, so renames never rewrite it.
     `stored` is the RAW document value, never the evaluated one.
     KNOWN BOUND: the autocomplete's candidate set is core's (numeric leaves,
     variables, functions) — a color/boolean row is offered the same names a
     numeric row is, since core has no per-kind candidate filter yet. -->
{#snippet equationEntry(row, paths, stored)}
  {@const editing = eqFocusKey === row.key || eqOpenKey === row.key}
  {@const text = editing ? eqDraft : equationDisplay(stored, app.rawState())}
  <!-- READS take the PRIMARY path: an error message and an evaluated badge are
       ONE value each, and every item in the set is being given the same
       expression, so the primary's derivation IS the row's derivation. -->
  {@const error = app.exprErrorAt(paths[0])}
  {@const invalid = editing && eqInvalid}
  <span class="eq-wrap">
    <div class="eq-highlight" aria-hidden="true">
      {#each equationPieces(text, app.rawState(), pickedItemId) as p}{#if p.cls}<span class="eq-tok eq-tok-{p.cls}">{p.text}</span>{:else}{p.text}{/if}{/each}
    </div>
    <input
      type="text"
      class="eq-input"
      class:invalid
      class:error={!invalid && !!error}
      spellcheck="false"
      aria-label={`${row.label} equation`}
      value={text}
      use:eqAutofocus={row.key}
      oninput={onEqInput}
      onscroll={syncEqScroll}
      onfocus={(e) => onEqFocus(e, row, paths, stored)}
      onblur={() => onEqBlur(row, stored)}
      onkeydown={onEqKeydown}
    />
    {#if !invalid && error}
      <Tooltip text={error}>
        <span class="eq-badge eq-badge-error">
          <iconify-icon icon="mdi:alert-circle-outline" width="13" height="13"></iconify-icon>
        </span>
      </Tooltip>
    {:else}
      <!-- Live evaluation of the equation — the kind's OWN value (a hex color, a
           boolean, an enum name), so the row still shows what it resolves to
           while the specialized editor is standing down. -->
      <span class="eq-badge">= {invalid ? "?" : equationBadge(getPath(app.state(), paths[0]))}</span>
    {/if}
    {#if editing}
      <EquationSuggest
        candidates={eqCandidates}
        highlighted={eqHighlighted}
        anchorEl={eqInputEl}
        onhover={(i) => (eqHighlighted = i)}
        onpick={acceptEqCandidate}
      />
    {/if}
  </span>
{/snippet}


<!-- A collapsible category accordion region. The header toggles collapse; the
     chevron reflects state. Rows render only when expanded. -->
{#snippet category(cat, state, opts)}
  <div class="prop-category">
    <button
      class="cat-header"
      aria-expanded={!collapsed[cat.id]}
      onclick={() => toggleCategory(cat.id)}
    >
      <iconify-icon icon={collapsed[cat.id] ? "mdi:chevron-right" : "mdi:chevron-down"} width="16" height="16"></iconify-icon>
      <span class="cat-title">{cat.title}</span>
    </button>
    {#if !collapsed[cat.id]}
      <div class="cat-rows">
        {#each cat.rows as row (row.key)}
          {@render propRow(row, state, opts)}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="inspector">
  <div class="inspector-head">
    <Dropdown
      items={itemChoices}
      value={pickedItemId}
      placeholder="— select item —"
      onchange={(v) => (app.selection = v)}
      item={pickerItem}
    />
  </div>

  {#if selCount > 1}
    <!-- THE INTERSECTION PANEL (manifest "Inspector shows the SET INTERSECTION of
         the selected items' attributes"; core/multiselect.js owns every rule).
         The two set ACTIONS below are unchanged and stay: the standing ruling is
         that a SET's visibility is HIDE ALL / SHOW ALL, always both, because "no
         toggle that has to guess the set's state". That ruling is about an ACTION
         control; the property rows underneath REPORT a mixed value and then unify,
         which is the reporting case (the rich-text toolbar already ships a
         set/unset/indeterminate boolean on the same footing). -->
    <div class="multi-select">
      <div class="multi-count">{selCount} items selected</div>
      <div class="item-actions">
        <Tooltip text="Hide every selected item on this slide (keyframes active: false)">
          <button class="btn" onclick={() => app.runCommand("delete-item")}>
            <iconify-icon icon="mdi:eye-off" width="16" height="16"></iconify-icon>
            Hide all
          </button>
        </Tooltip>
        <!-- BOTH explicit set-actions, never a mixed-state guessing toggle
             (user ruling: "hide all... didn't turn into show all"). Show all
             activates every selected item here; not-yet-created items follow
             the ratified creation-state-copy semantics. -->
        <Tooltip text="Keyframe active: true here for every selected item (not-yet-created items are created here)">
          <button class="btn" onclick={() => app.runCommand("show-item")}>
            <iconify-icon icon="mdi:eye" width="16" height="16"></iconify-icon>
            Show all
          </button>
        </Tooltip>
        <!-- Leads with the WORD: "purge" is this app's specific term for
             destroy-everywhere, the counterpart to Delete's deactivate-on-this-
             slide. A tooltip that only paraphrases it never teaches it. -->
        <Tooltip text="Purge — remove every selected item from existence (all slides)">
          <button class="btn danger" aria-label="Purge selected" onclick={() => app.runCommand("purge-item")}>
            <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
      </div>
      <!-- WHAT IS NOT BEING EDITED, said out loud. An item that does not exist on
           this slide has no value to compare and must not be keyframed (that would
           manufacture a typeless item), so core drops it — and the panel reports
           it rather than editing fewer items than the user selected. -->
      {#if multiPanel.skipped.length > 0}
        <div class="multi-note">
          Not on this slide, so not being edited: {multiPanel.skipped.map((id) => app.displayName(id)).join(", ")}
        </div>
      {/if}
      <!-- SHARED-LOOKING BUT NOT SHARED. A key both items declare with a
           DIFFERENT contract (a rect's corner radius is a length, a star's is a
           0..0.5 fraction; a magnifier's `shape` offers circle/box where the shape
           widget offers twenty silhouettes) is excluded, and saying which aspect
           excluded it is the difference between an honest panel and one that looks
           like these items have less in common than they do. -->
      {#if multiPanel.conflicts.length > 0}
        <div class="multi-note">
          Not editable together (the same name means different things here):
          {#each multiPanel.conflicts as c (c.key)}
            <Tooltip text={`These items disagree about this property's ${c.aspects.join(", ")} — so one value cannot mean the same thing to all of them.`}
              ><span class="multi-conflict">{c.key}</span></Tooltip>
          {/each}
        </div>
      {/if}
      {#if multiPanel.rows.length === 0}
        <div class="empty">No properties in common</div>
      {/if}
    </div>
    {#if multiPanel.rows.length > 0}
      <div class="rows">
        {#each multiCategories as cat (cat.id)}
          {@render category(cat, sel?.state ?? {}, {
            keyframes: true,
            disabled: false,
            // select / asset / text rows commit through this generic seam, so the
            // fan-out versions are all they need. number / angle / colour /
            // boolean rows drive their own Tier-1 field with `paths` instead.
            onpreview: previewMulti,
            oncommit: commitMulti,
            itemId: sel?.itemId ?? null,
            pathState: app.rawState(),
            hoverPreview: previewMulti,
            multi: true,
          })}
        {/each}
      </div>
    {/if}
  {:else if target?.kind === "transition"}
    <!-- TRANSITION target: type dropdown + the type's rows through the SAME
         generic machinery, WITHOUT keyframe diamonds (transitions are
         per-boundary CONFIG, not keyframable tweened state). -->
    {#if transitionState}
      <div class="row transition-type-row">
        <span class="label">Type</span>
        <Dropdown
          items={transitionTypeChoices}
          value={transitionState.type}
          onchange={(v) => app.setTransitionType(transitionSlideId, v)}
        />
        <span class="kf-controls" aria-hidden="true"></span>
      </div>
      <div class="rows">
        {#each transitionCategories as cat (cat.id)}
          {@render category(cat, transitionState, {
            keyframes: false,
            disabled: false,
            onpreview: commitTransition,
            oncommit: commitTransition,
          })}
        {/each}
      </div>
    {:else}
      <div class="empty">Transition unavailable</div>
    {/if}
  {:else if sel}
    <!-- CREATED item. Name row + Purge trash-can share ONE row (manifest Round
         12: "trash can icon… same row as the name… so that we don't confuse them
         with properties"). The trash sits at the name row's RIGHT, occupying the
         trailing keyframe-controls column the row already reserves for alignment
         — so it needs no new grid geometry and sits where destructive/kf
         controls sit on every other row. -->
    <div class="row name-row">
      <span class="label">Name</span>
      <input
        type="text"
        placeholder={app.displayName(sel.itemId)}
        value={sel.state.name ?? ""}
        onchange={(e) => app.renameSelection(e.target.value)}
      />
      <span class="kf-controls name-actions">
        {#if purgeable}
          <Tooltip text="Purge — remove from existence (all keyframes, all slides)">
            <button class="btn-icon danger" aria-label="Purge item" onclick={() => app.runCommand("purge-item")}>
              <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
            </button>
          </Tooltip>
        {/if}
      </span>
    </div>
    <div class="rows">
      <!-- VISIBILITY is a property row like all the others (manifest Round 12) —
           a keyframeable boolean with the ‹ ◆ › controls, ABOVE the categories
           so it is ALWAYS reachable (also the actionable row for not-yet-created
           items). Eye iconography per the SlideNav slide-toggle visual language.
           Camera (purgeable:false) shows no visibility row — it is mandatory. -->
      {#if purgeable}
        {@render propRow(
          { key: "active", label: "Visible", kind: "boolean",
            onIcon: "mdi:eye", offIcon: "mdi:eye-off",
            onText: "Visible on this slide — click to hide (keyframes active: false)",
            offText: "Hidden on this slide — click to show (keyframes active: true)",
            // `help` proves the (?) affordance on a UNIVERSAL boolean row (the
            // Visible row is defined inline, not from the shared registry). Once
            // `active` moves into core/properties.js this inline help is
            // superseded by the registry's (row.help flows through unchanged).
            help: VISIBLE_ROW_HELP },
          sel.state,
          // hoverPreview: this CREATED-item context previews without committing,
          // so its select rows may preview the option under the pointer. (The
          // Visible row itself is a boolean and has no active-row notion; the
          // field is threaded here so both created-item contexts are identical.)
          { keyframes: true, disabled: false, onpreview: previewField, oncommit: commitField, itemId: sel.itemId, pathState: app.rawState(), hoverPreview: previewField }
        )}
      {/if}
      {#each itemCategories as cat (cat.id)}
        {@render category(cat, sel.state, {
          keyframes: true,
          disabled: false,
          onpreview: previewField,
          oncommit: commitField,
          itemId: sel.itemId,
          pathState: app.rawState(),
          // Every select row of a CREATED item previews the option under the
          // pointer / arrow-key highlight (blendMode, shape kind, cursor kind,
          // item retargeting, …). previewField is setPreview only — the document
          // is untouched until the pick, so no undo entry can come from hovering.
          hoverPreview: previewField,
        })}
      {/each}
    </div>
  {:else if pickedItemId != null && creationState}
    <!-- NOT YET CREATED on this slide (manifest Round 12B): show ALL its normal
         property rows GRAYED/disabled (values from its creation slide), but keep
         the VISIBILITY row ACTIONABLE ("otherwise it's useless"). Toggling it ON
         runs activateNotYetCreated() — writes the item's creation-slide state +
         active:true onto THIS slide (lead ruling). The visibility row shows OFF
         (the item does not exist here yet). Name + Purge still act. -->
    <div class="row name-row">
      <span class="label">Name</span>
      <input
        type="text"
        placeholder={app.displayName(pickedItemId)}
        value={allDocumentItems(app.doc).find((it) => it.id === pickedItemId)?.name ?? ""}
        onchange={(e) => app.renameSelection(e.target.value)}
      />
      <span class="kf-controls name-actions">
        {#if purgeable}
          <Tooltip text="Purge — remove from existence (all keyframes, all slides)">
            <button class="btn-icon danger" aria-label="Purge item" onclick={() => app.runCommand("purge-item")}>
              <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
            </button>
          </Tooltip>
        {/if}
      </span>
    </div>
    <div class="rows">
      {#if purgeable}
        <!-- Actionable visibility row: OFF here; clicking activates the item on
             this slide (creation-state copy + active:true, one undo unit). -->
        <div class="row">
          <!-- The label carries the property's MEANING, never an echo of itself
               ("hovering a row just repeating its own label is BANNED as
               useless" — this file's own rule, above). Same sentence the
               created-item Visible row's `help` uses, so one property reads the
               same whichever branch renders it. -->
          <Tooltip text={VISIBLE_ROW_HELP}><span class="label">Visible</span></Tooltip>
          <div class="boolfield">
            <Tooltip text={creationIndex != null
              ? `Not created until slide ${creationIndex + 1} — click to show it here (copies its properties onto this slide)`
              : "Click to show this item on this slide"}>
              <button class="boolbtn" aria-label="Visible" aria-pressed="false" onclick={activateNotYetCreated}>
                <iconify-icon icon="mdi:eye-off" width="16" height="16"></iconify-icon>
              </button>
            </Tooltip>
          </div>
          <span class="kf-controls" aria-hidden="true"></span>
        </div>
      {/if}
      {#each creationCategories as cat (cat.id)}
        {@render category(cat, creationState, {
          keyframes: false,
          disabled: true,
          onpreview: () => {},
          oncommit: () => {},
          itemId: pickedItemId,
          pathState: allItemsState,
        })}
      {/each}
      {#if creationIndex != null}
        <div class="empty not-created-note">Not created until slide {creationIndex + 1}</div>
      {/if}
    </div>
  {:else if pickedItemId != null}
    <!-- Picked but no creation state resolvable (e.g. brand-new orphan) — the
         degenerate not-created case. -->
    <div class="empty">Not created yet on this slide</div>
  {:else}
    <div class="empty">Nothing selected</div>
  {/if}
</div>
