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
  import SearchableDropdown from "../../../lib/SearchableDropdown.svelte";
  import { appRankItems } from "./searchRank.js";
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
  import ItemVariablesPanel from "./ItemVariablesPanel.svelte";
  import LabelDivider from "./LabelDivider.svelte";
  import GalleryPopup from "./GalleryPopup.svelte";
  import { allDocumentItems, keyframeIndices, foldState, itemFallbackName } from "../core/document.js";
  import { transitionInspector, TRANSITION_TYPES } from "../core/transitions.js";
  import {
    canonicalPropPath, compiled, displayToStored, storedToDisplay, equationTokenSpans, isEquationValue,
  } from "../core/expressions.js";
  import { suggestEquation, acceptSuggestion } from "../core/equationSuggest.js";
  import { makeEquationSuggestKeydown } from "./equationSuggestKeys.js";
  import { richTextToPlain, withPlainTextReplaced } from "../core/richtext.js";
  import { CUSTOM_CATEGORY, PROPS, RETIRED_ROW_KINDS, selectRowItems } from "../core/properties.js";
  import { LIST_ROW_KIND } from "../core/lists.js";
  import { MIXED_MARK, fanOutPairs } from "../core/multiselect.js";
  import { commandUnavailableReason, unavailableMessage } from "../core/commands.js";
  import { isHexColor } from "../core/interpolators.js";
  import { getPath } from "../core/deltas.js";
  import { copyText } from "./clipboard.js";

  let { app } = $props();

  // How long the copy-path button flashes its "Copied!" check after a
  // successful copy (positive feedback — the button icon swaps to a check).
  const COPY_FLASH_MS = 1200;
  // The row `key` whose copy button is currently flashing "Copied!", or null.
  let justCopiedKey = $state(null);

  // ── THE GALLERY ROW ASPECT (web/GalleryPopup.svelte) ──────────────────────
  // A row declaring `gallery: (state) => spec` (plugins/iconify.js's
  // iconifyGallerySpec) gets a gutter button that
  // opens the SAME {grid, search} spec CanvasToolbar renders on double-click,
  // anchored under this button instead of the canvas. AT MOST ONE open at a
  // time (a single popup instance, not one per row), keyed by {itemId, key} so
  // switching rows or items closes any popup that was open elsewhere.
  let galleryOpenFor = $state(null); // {itemId, key} | null
  let galleryAnchorEl = $state(null);
  let gallerySpec = $state(null);
  // Plain mirror of `galleryOpenFor !== null`, because GalleryPopup's `open` is
  // $bindable(false) (the ordinary Modal/AssetField bind:open shape) rather
  // than a derived value — bind: needs a plain assignable local, not an
  // expression. Kept in sync by toggleGallery(); the $effect below closes
  // galleryOpenFor when the popup reports itself closed (Escape, outside
  // click, or a pick — see GalleryPopup.svelte's close()).
  let galleryPopupOpen = $state(false);
  $effect(() => {
    if (!galleryPopupOpen) galleryOpenFor = null;
  });

  /** Command. Opens (or, on a repeat click, closes) the gallery popup for one
   * row. `state` is the row's CURRENT folded state, so the spec's grid.value
   * always reflects what the item holds right now — the same call shape
   * floatingToolbar(state) receives on double-click. */
  function toggleGallery(row, state, itemId, anchorEl) {
    const isThisRow = galleryOpenFor?.itemId === itemId && galleryOpenFor?.key === row.key;
    if (isThisRow) {
      galleryPopupOpen = false;
      return;
    }
    galleryAnchorEl = anchorEl;
    gallerySpec = row.gallery(state);
    galleryOpenFor = { itemId, key: row.key };
    galleryPopupOpen = true;
  }

  /** Command. Commits the popup's picked value onto the row's property as ONE
   * undo unit — the standard preview→commit seam (AssetField's oncommit, the
   * CanvasToolbar grid's pick(), same pattern). */
  function commitGalleryPick(row, itemId, value) {
    app.setPreview([[["items", itemId, row.key], value]]);
    app.commitPreview();
  }

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

  // THE RETYPE MENU for the selected item: eligible target types, each carrying
  // the coercion preview computed against this item's LIVE folded state (so the
  // warnings re-render as the values change — the "real-time" half of the
  // ruling). Empty means "not retypeable", and the header falls back to the
  // plain caption. Derived, not cached: app.retypeChoices() reads app.state(),
  // which is itself a rune-tracked derivation, so an edit to a warned-about
  // property updates the tooltip on the very next frame.
  let retypeMenu = $derived(app.retypeChoices());

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
  // THE SUBJECT of a multi-selection panel, for the one section that names its
  // widget (customCategoryTitle). Selecting three lens flares has a subject —
  // "Lens Flare settings" is exactly right and saying "Widget settings" there
  // would be a needless downgrade. Selecting a flare and a rect does not, and
  // null is how that is said.
  let sharedWidgetTitle = $derived.by(() => {
    const plugins = app.selectedNodes().map((n) => n.plugin);
    return plugins.length && plugins.every((p) => p.type === plugins[0].type) ? plugins[0].title ?? null : null;
  });
  let multiCategories = $derived(multiPanel ? groupRows(multiPanel.rows.map((r) => r.row), null, sharedWidgetTitle) : []);

  /** Query. Every selected item's state path for one row key — the fan-out write
   * targets a Tier-1 field receives as `paths` (the primary FIRST, so the field's
   * singular `path` and this list agree about who is being read). */
  function multiPaths(key) {
    // THE ROW'S OWN `appliesTo`, NOT THE WHOLE SELECTION. They are the same list
    // in intersection mode; in UNION mode a row may be declared by only some of
    // the selected items, and writing it to the others would store a property
    // their plugin never declared and silently ignores. Falls back to the full
    // set only if a row somehow arrives without the field, which core always
    // supplies.
    const ids = multiByKey.get(key)?.row?.appliesTo ?? multiPanel?.itemIds ?? [];
    return ids.map((id) => ["items", id, ...key.split(".")]);
  }

  /**
   * Command. UNIFIES a mixed row to the primary's value — the user's "when I
   * click them, it would have to unify them all to the same value". ONE undo unit
   * for the whole set (app.unifySelection). After it lands the row is no longer
   * mixed, so the ordinary field takes over and the next gesture edits all N
   * together, which is the "make a bunch of things fade in at the same time" flow.
   */
  function unifyRow(entry) {
    // Scoped to the row's own participants for the same reason multiPaths is —
    // in union mode "unify them all" means all the ones that HAVE this property.
    app.unifySelection(entry.row.key, entry.seed, entry.row.appliesTo ?? null);
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
    // NOTE: there is deliberately NO `custom:` entry — see customCategoryTitle().
    other: "Other",
  };
  const CATEGORY_ORDER = ["positioning", "fillMaterial", "strokeMaterial", "formatting", "effects", "text", "arrow", "lens", "blur", "custom", "other"];

  /**
   * Pure function. The display title for the CUSTOM_CATEGORY bucket — a widget's
   * own declared "self.*" knobs (core/properties.js).
   *
   * THIS SECTION USED TO BE CALLED "Custom", ON EVERY WIDGET (manifest R6-5). The
   * user's ruling: *"Custom is supposed to be reserved for what people make, or
   * not at all"* — a lens flare's ghost count is not something the user made, it
   * is what a lens flare IS. So the section is named after the widget, verbatim
   * per R6-5.1 (*"Lens Flare settings"*), and the name is DERIVED from the
   * plugin's own `title` rather than listed per widget: 24 of the 96 plugins have
   * such a section, and a hand-kept table of 24 names is the mirror-drift shape
   * this round exists to remove.
   *
   * `widgetTitle` is null when the panel has no single subject — a HETEROGENEOUS
   * multi-selection, whose intersection really can contain custom rows (Liquid
   * Glass and Frosted Glass share `blurRadius`, `tint`, `cornerRadius`). There is
   * no one widget to name then, so the section says what it generically is.
   *
   * @param {string|null} widgetTitle - the selected plugin's `title`, or null
   * @returns {string}
   *
   * @example customCategoryTitle("Lens Flare") // "Lens Flare settings"
   * @example customCategoryTitle("Corkboard Note") // "Corkboard Note settings"
   * @example customCategoryTitle(null) // "Widget settings"
   */
  function customCategoryTitle(widgetTitle) {
    return `${widgetTitle ?? "Widget"} settings`;
  }

  /** Pure function. Groups plugin inspector rows into ordered category buckets:
   * [{id, title, rows}]. Preserves row order within a category; known
   * categories sort by CATEGORY_ORDER, unknown ones append in first-seen order.
   *
   * A row declaring `visibleWhen(state)` is DROPPED (not just disabled) when it
   * returns false against `state` — the row-visibility aspect (manifest:
   * "the width row shouldn't even show while stroke material is off"). `state`
   * is optional: omitting it (or a row with no `visibleWhen`) keeps every row,
   * so every pre-existing call site and every visibleWhen-less row is unaffected.
   * A category left with zero rows after filtering is dropped entirely, so an
   * all-conditional section (none today) would not render an empty accordion.
   *
   * `widgetTitle` names the panel's subject widget, and the ONLY category that
   * reads it is CUSTOM_CATEGORY — see customCategoryTitle(). Null (the default)
   * is honest for the transition panel, which has no widget and no custom rows.
   *
   * Examples:
   *     >>> // rows [{key:"x",category:"positioning"},{key:"fill",category:"fillMaterial"}]
   *     >>> // → [{id:"positioning",title:"Positioning",rows:[…x]},{id:"fillMaterial",…}]
   *     >>> // groupRows([{key:"strokeWidth",category:"strokeMaterial",visibleWhen:(s)=>!isPaintOff(s.stroke)}], {stroke:{type:"none"}})
   *     >>> // → [] (the row is hidden; the now-empty strokeMaterial bucket is dropped)
   *     >>> // groupRows([{key:"ghostCount",category:"custom"}], null, "Lens Flare")
   *     >>> // → [{id:"custom",title:"Lens Flare settings",rows:[…ghostCount]}]
   */
  function groupRows(rows, state = null, widgetTitle = null) {
    const buckets = new Map();
    for (const row of rows) {
      if (state && typeof row.visibleWhen === "function" && !row.visibleWhen(state)) continue;
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
      title: id === CUSTOM_CATEGORY
        ? customCategoryTitle(widgetTitle)
        : CATEGORY_TITLES[id] ?? (id.charAt(0).toUpperCase() + id.slice(1)),
      rows: buckets.get(id),
    }));
  }

  /**
   * Pure function. True iff this row RESTACKS to the panel's full width, i.e. it
   * has no label⟷value boundary at --a-label-frac for a divider to mark.
   *
   * Two kinds do: a LIST row (app.css `.row.row-list` — the list gets its own
   * full-width second line) and a PAINT row (`:has(.gradient-presets)` — the
   * gradient stack's mode strip, preset library and stops list span the panel).
   * Both are declared by the ROW, which is why this is answerable here without
   * touching the DOM — the earlier attempt measured offsetTop at runtime and kept
   * racing the category's mount (see LabelDivider's header).
   *
   * @param {{kind: string, paint?: boolean}} row An inspector row def.
   * @returns {boolean}
   *
   * @example fullWidthRow({key: "x", kind: "number"})
   * false
   * @example // a fill/stroke paint row — PaintField's stack spans the panel
   * fullWidthRow({key: "stroke", kind: "color", paint: true})
   * true
   * @example // a plain colour row keeps the shared value column
   * fullWidthRow({key: "shadowColor", kind: "color"})
   * false
   * @example // a list row (a polygon's points) restacks onto a second line
   * fullWidthRow({key: "points", kind: "list"})
   * true
   */
  function fullWidthRow(row) {
    const kind = rowKind(row);
    return kind === LIST_ROW_KIND || (kind === "color" && !!row.paint);
  }

  /**
   * Pure function. Splits a category's rows into RUNS for divider purposes: each
   * run is a maximal stretch of rows that all share the label⟷value boundary,
   * and full-width rows sit BETWEEN runs, in their own single-row run.
   *
   * WHY THE PANEL NEEDS THIS, and it is the user's complaint verbatim: "that line
   * is still extending too far down… visually going past the stroke material
   * area". One divider per CATEGORY spanned everything the category held —
   * including a gradient paint stack's mode strip and preset library, which have
   * no column to resize. Splitting into runs means each divider spans only rows
   * that actually have a boundary, which is the same rule that moved the divider
   * from `.rows` to `.cat-rows`, applied one level deeper.
   *
   * A run carries `boundary`: true for a stretch of ordinary rows (mount a
   * divider), false for a full-width row (mount none — PaintField mounts its own
   * around the sub-rows INSIDE its stack).
   *
   * @param {Array<object>} rows A category's rows, in order.
   * @returns {Array<{boundary: boolean, rows: Array<object>}>}
   *
   * @example // an all-ordinary category is ONE boundary run — one divider, as before
   * rowRuns([{key: "x", kind: "number"}, {key: "y", kind: "number"}])
   * // => [{boundary: true, rows: [{key: "x", …}, {key: "y", …}]}]
   * @example // Stroke Material: the paint row first, then width/caps below it
   * rowRuns([{key: "stroke", kind: "color", paint: true}, {key: "strokeWidth", kind: "number"}])
   * // => [{boundary: false, rows: [stroke]}, {boundary: true, rows: [strokeWidth]}]
   * @example // a paint row BETWEEN ordinary rows splits them into two runs
   * rowRuns([{key: "a", kind: "number"}, {key: "fill", kind: "color", paint: true}, {key: "b", kind: "number"}]).map((r) => r.boundary)
   * // => [true, false, true]
   * @example rowRuns([])
   * // => []
   */
  function rowRuns(rows) {
    const runs = [];
    for (const row of rows) {
      const boundary = !fullWidthRow(row);
      const last = runs[runs.length - 1];
      // A full-width row always starts its own run (never merges), so two adjacent
      // paint rows stay separable and neither gets a divider.
      if (last && last.boundary && boundary) last.rows.push(row);
      else runs.push({ boundary, rows: [row] });
    }
    return runs;
  }

  let itemCategories = $derived(sel ? groupRows(sel.plugin.inspector ?? [], sel.state, sel.plugin.title ?? null) : []);
  let creationCategories = $derived(
    creationState ? groupRows(app.registry.get(creationState.type)?.inspector ?? [], creationState, app.registry.get(creationState.type)?.title ?? null) : []
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
   * Pure function. The REAL state key a row reads/writes/keyframes through —
   * `row.key` for every ordinary row, `row.writeKey` for one that displays
   * under a DIFFERENT name than it stores (currently only cx/cy: displayed as
   * "cx", written through "x" — core/properties.js PROPS.cx). Deliberately
   * separate from `row.key` itself: `row.key` stays UNIQUE within a plugin's
   * `.inspector` array (core/multiselect.js intersectRows treats a repeated
   * key as a plugin defect, and Inspector's own multiByKey/eqOpenKey/
   * justCopiedKey bookkeeping is keyed by it too — a cx row sharing "x" broke
   * both on first landing). Every path/keyframe/equation call site in this
   * file reads THROUGH this, never `row.key` directly, so cx/cy's writes land
   * on x/y exactly like a same-named row would.
   *
   * @example writeKey({key: "x"}) // "x"
   * @example writeKey({key: "cx", writeKey: "x"}) // "x"
   */
  function writeKey(row) {
    return row.writeKey ?? row.key;
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
  // KEEPS the per-slide consequence (an item can be on some slides and not
  // others) — that IS the property, and a reader who does not know it will
  // misread the checkbox. What went is the restatement of that same fact in
  // implementation terms ("keyframes active: false here"), which said it twice.
  const VISIBLE_ROW_HELP =
    "Whether this item shows on THIS slide. Keyframeable like any other property, so an item can appear on some slides and not others.";

  // The other two UNIVERSAL rows' meanings. Same rule as VISIBLE_ROW_HELP: the
  // help is the property's MEANING, never an echo of the label (a label-echo
  // tooltip is banned in this file), and it says the one thing a first-time
  // reader cannot guess.
  // WIDGET TYPE names what a retype DOES rather than what a type IS, because the
  // surprising half is that the values come with you — core/retype's plan carries
  // a property across when the two types agree on its row kind, and only resets
  // the ones that disagree (the menu's warning triangles list exactly those).
  const WIDGET_TYPE_ROW_HELP =
    "What kind of widget this is. Changing it keeps every property the two types agree on and resets only the ones they do not — the menu marks those with a warning and lists them.";
  // NAME says where the name SHOWS UP, which is the reason to set one; that it is
  // optional, and what fills the gap when it is not set.
  const NAME_ROW_HELP =
    "What this widget is called in the item picker, the outline and equations. Optional — left blank it is called by its type and a number.";

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
      // Project-script exports are offered here too — see NumericField's note.
      ? suggestEquation(eqDraft, eqInputEl.selectionStart ?? eqDraft.length, app.rawState(), app.registry, pickedItemId, app.projectScriptExports())
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
    const k = writeKey(row);
    return k in PROPS || getPath(sel.plugin.defaults, k.split(".")) !== undefined;
  }

  /** Query. The RAW stored value at a row's item path — an `=` string when the
   * row is equation-bound. The specialized editors are handed the EVALUATED
   * state (where an equation has already resolved to a color/boolean/string),
   * so this raw read is the only way to see the equation itself. Mirrors
   * NumericField's stored/evaluated split. */
  function rowStored(row) {
    return getPath(app.rawState(), ["items", pickedItemId, ...writeKey(row).split(".")]);
  }

  /** Query. Is the row SHOWING the equation field — because the document stores
   * an equation there (core's own isEquationValue is the single source of truth
   * for that question), or because the ƒ button just opened entry on THIS row of
   * THIS item (see eqOwnerId)? */
  function equationActive(row, stored) {
    if (eqOpenKey === row.key && eqOwnerId === pickedItemId) return true;
    return isEquationValue(sel.plugin, writeKey(row).split("."), stored);
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
    // Project-script exports count as resolvable identifiers here too — see
    // NumericField's note (a working equation must never paint red).
    const spans = equationTokenSpans(clean, state, selfId, app.projectScriptExports());
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
   * (nothing is written until commit).
   *
   * The seed is read from `paths[0]` — the PRIMARY, the same path `eqPath`
   * takes and the same one `equationEntry` reads its error and evaluated badge
   * from. Over a SET the primary's value IS the seed by the same rule
   * core/multiselect.js `rowMixedState` already uses, so opening entry on a
   * mixed row proposes the primary's value rather than an arbitrary one.
   * (It read a bare `path` until this line was fixed — an undeclared
   * identifier, so every ƒ click on a color/boolean/select/asset/text row threw
   * ReferenceError AFTER eqOpenKey was set, i.e. entry opened UNSEEDED.
   * tests/multiselect_equation_probe.js pins it, and reproduced the live
   * `PAGEERROR path is not defined` before the fix.)
   *
   * AN EQUATION THE PRIMARY ALREADY HOLDS IS KEPT, not re-seeded from its
   * evaluated value. In a SINGLE selection this branch is unreachable (the ƒ
   * toggle calls dropEquation when the row already renders as an equation), but
   * over a SET it is reachable the moment the row is MIXED: the primary can hold
   * `= expr` while another item holds a literal. Re-seeding from app.state()
   * there would silently substitute the expression's CURRENT NUMBER for the
   * expression — the row would look unchanged and commit a frozen literal. */
  function beginEquation(row, paths) {
    eqOpenKey = row.key;
    eqOwnerId = pickedItemId;
    eqFocusKey = row.key;
    eqPath = paths[0];
    eqPaths = paths;
    const stored = getPath(app.rawState(), paths[0]);
    eqDraft = isEquationValue(sel.plugin, writeKey(row).split("."), stored)
      ? equationDisplay(stored, app.rawState())
      : equationSeed(getPath(app.state(), paths[0]));
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

  /** Command. Keyboard for the universal `=` row's equation input — the shared
   *  equation-suggest keyboard (web/equationSuggestKeys.js), which AngleField and
   *  NumericField wire identically. The behaviour is documented there; this is
   *  only the wiring. This docblock used to read "NumericField's handler,
   *  unchanged in behavior" above a verbatim copy of it — now it IS that handler. */
  const onEqKeydown = makeEquationSuggestKeydown({
    isOpen: () => eqSuggestOpen,
    candidates: () => eqCandidates,
    highlighted: () => eqHighlighted,
    setHighlighted: (i) => (eqHighlighted = i),
    setOpen: (open) => (eqSuggestOpen = open),
    accept: acceptEqCandidate,
    commit: commitEquation,
    revert: cancelEquation,
  });

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

  // ── THE UNIVERSAL SECTION (R6-6.6) ──────────────────────────────────────────
  // "Order Type / Name / Visible as three ordinary properties in ONE section,
  // since every widget has them" (user). So they ARE ordinary rows now — same
  // propRow, same grid, same label column, same value track — instead of the
  // caption + loose name div + loose Visible row they were, which is why the
  // Name label used to sit 30px (two gutter slots) LEFT of every other label in
  // the panel: it rendered a bare <span class="label"> with none of the row's
  // label chrome. Measured before/after in tests/inspector_row_uniformity_probe.js.
  //
  // "UNIVERSAL" IS THE CODEBASE'S OWN WORD for exactly this set, and it is the
  // oldest one available: core/derive.js:230 "`active` is a universal widget
  // property", from the V1 commit; AUTHORING.md:99 "`active` is a universal
  // property that every widget has" — the same sentence R6-6.6 justifies the
  // section with; and this file already calls the Visible row "a UNIVERSAL
  // boolean row". Runner-up "Widget" loses three ways: it would repeat the
  // first row's own dictated label ("Widget type"), it names the OWNER where
  // every other section title names a TOPIC, and its user-facing use is ten days
  // younger. (R6-22.3: where the manifest is silent, the older pattern wins.)
  //
  // THE ID IS `__`-PREFIXED for the reason the Variables accordion's is: a
  // hard-coded section must own an id no plugin can declare, or a plugin filing
  // rows under it would render a second block with the same title.
  const UNIVERSAL_CATEGORY_ID = "__universal";

  /** The three rows every widget has, in the ruled order. A category shape
   * ({id, title, rows}) so it renders through the SAME `category` snippet the
   * plugin sections do — which is also how it inherits the collapse memory and
   * the label⟷value divider without either being restated here.
   *
   * `keyframes: false` on type and name is the honest current state, not a
   * design bound: a name is not per-slide state at all, while R6-6.7 ruled that
   * widget type IS keyframeable and is blocked only on the retype command
   * writing at the CURRENT slide (web/app.svelte.js #creationState). See the
   * propRow header — flipping that one flag is the whole UI half of it. */
  /** True while the picked item exists in the document but NOT on this slide —
   * the Round 12B branch. Its Universal rows differ in exactly two ways, both
   * about `active`: the item is not visible here whatever its creation slide
   * says, and turning it on CREATES it here rather than keyframing a boolean. */
  let notYetCreated = $derived(!sel && creationState != null);

  let universalCategory = $derived({
    id: UNIVERSAL_CATEGORY_ID,
    title: "Universal",
    rows: [
      // NAME FIRST, TYPE SECOND (user, 2026-08-02: "Name should be on the top,
      // widget type should be second to that under universal"). It reads the way
      // you address a thing: what you call it, then what it is. The previous order
      // put the machine's answer above the author's.
      { key: "name", label: "Name", kind: "text", keyframes: false,
        placeholder: app.displayName(pickedItemId), purge: purgeable, help: NAME_ROW_HELP },
      // KEYFRAMEABLE, at last — user, 2026-08-02: "why is there no keyframe object
      // to the right of widget type?" The answer was already ruled and written
      // down: R6-6.7 settled that widget type IS a keyframeable property, `type`
      // is carried per-slide by the fold, and the note in propRow said dropping
      // this flag was the WHOLE UI change "once the retype command writes at the
      // CURRENT slide". Verified that it does — app.retypeSelection passes
      // this.slideIndex to core/retype.retypedItem, which writes through
      // `keyframed(doc, slideIndex, ["items", id, "type"], …)` and keyframes every
      // coerced property alongside it. So the precondition had quietly been met
      // and the row was the only thing still saying no.
      { key: "type", label: "Widget type", kind: "select", optionsFrom: "retype",
        help: WIDGET_TYPE_ROW_HELP },
      // The camera is mandatory (purgeable:false) and has no visibility to
      // keyframe, exactly as before this section existed.
      ...(purgeable
        ? [{ key: "active", label: "Visible", kind: "boolean",
            // NOT-YET-CREATED keeps its own OFF sentence — the click does
            // something bigger there (it copies the creation-slide state onto
            // this slide), and a tooltip that said "keyframes active: true"
            // would describe the wrong write.
            keyframes: !notYetCreated,
            onIcon: "mdi:eye", offIcon: "mdi:eye-off",
            onText: "Visible on this slide — click to hide (keyframes active: false)",
            offText: notYetCreated
              ? (creationIndex != null
                ? `Not created until slide ${creationIndex + 1} — click to show it here, copying its properties onto this slide`
                : "Show this item on this slide")
              : "Hidden on this slide — click to show (keyframes active: true)",
            help: VISIBLE_ROW_HELP }]
        : []),
    ],
  });

  /** The state the Universal rows READ. For a created item that is just its
   * folded state. For a NOT-YET-CREATED one, two corrections: the fold stops at
   * the creation slide, so a name set on a LATER slide is not in it
   * (allDocumentItems scans every slide, which is where that branch has always
   * read the name from), and `active` is FALSE here regardless of what the
   * creation slide keyed — the item is not on this slide, which is the whole
   * meaning of the branch. Kept as one derived rather than two call sites so the
   * two branches cannot drift. */
  let universalState = $derived.by(() => {
    if (sel) return sel.state;
    if (!creationState) return null;
    const doc = allDocumentItems(app.doc).find((it) => it.id === pickedItemId);
    return { ...creationState, name: doc?.name, active: false };
  });

  /** Command. The Universal section's COMMIT seam. Only one of its three rows is
   * an ordinary property write; the other two go through commands:
   *   type → app.retypeSelection, which runs core/retype's coercion PLAN as one
   *          undo unit (a bare `type` keyframe would leave the old type's values
   *          in slots the new plugin cannot read).
   *   name → app.renameSelection, which writes the item's name where a name
   *          lives (its creation slide), not as a per-slide keyframe here.
   *   active, while NOT YET CREATED → activateNotYetCreated, the only write that
   *          means anything before the item exists here. On a created item it is
   *          the plain keyframe every plugin row uses. */
  function commitUniversal(key, kind, raw) {
    if (key === "type") app.retypeSelection(raw);
    else if (key === "name") app.renameSelection(raw);
    else if (notYetCreated) activateNotYetCreated();
    else commitField(key, kind, raw);
  }

  /** Command. The Universal section's PREVIEW seam. Type and name have no
   * preview: both commit through a command rather than through a keyframe, so
   * there is no staged value for setPreview to hold and no revert for
   * cancelPreview to perform — previewing a retype would have to run the whole
   * coercion plan against the live document, which is a write wearing a
   * preview's clothes. Visible previews exactly as it always has. */
  function previewUniversal(key, kind, raw) {
    if (key === "type" || key === "name") return;
    previewField(key, kind, raw);
  }

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

<!-- THE LABEL⟷VALUE DIVIDER, one per EXPANDED CATEGORY (.cat-rows). A snippet
     rather than the component written out at each site, so the placement rule
     ("first child of a .cat-rows block") is stated once.

     IT MOVED HERE FROM .rows, on the user's ruling that it be "only visually
     shown and clickable in between the drop-down areas for formatting and
     stroke material, etc." — i.e. inside the collapsible property groups, and
     nowhere else. A .rows block also spans the category HEADERS, the Name row,
     the Visible row and the not-created note; a col-resize strip over those
     offered to resize a column they do not have. Mounting inside the `category`
     snippet makes the divider a property of the group, so it appears and
     disappears with the group rather than being maintained alongside it.

     These are the PROPERTY family (web/labelFrac.js LABEL_DIVIDER_PROPERTY),
     which is the component's default, so the snippet passes no key.

     The Variables Panel mounts its own from web/VariablesPanel.svelte on that
     SAME family, deliberately: the round-11 "columns line up" ruling is that the
     two PANELS share one boundary x, and dragging either must move both. It is
     NOT the "variable properties" family despite the name — that one is the rows
     NESTED inside a composite editor (PaintField's gradient geometry and material
     knobs), which read their own number so a nested strip does not stack on top
     of these. Do not "fix" the apparent inconsistency; splitting the two panels
     would regress a shipped ruling. -->
{#snippet labelDivider()}
  <LabelDivider {app} />
{/snippet}

<!-- ONE ROW of the retype menu. A clean target renders as its bare title; a
     COERCING target carries a warning triangle on the LEFT of the name and a
     tooltip listing exactly what it would take away.

     Verbatim ruling: "it would be rather dangerous if something is coerced
     without the user knowing… highlighting it red in the dropdown and putting
     them at the very bottom with a mouse hover that says WARNING — types will be
     coerced, in bold, followed by bullet points for every property that will be
     coerced, from what to what, giving the values… with a warning sign on the
     left side of the name."

     The bullets come from core/retype.coercionPreview, which is the SAME
     function retypePlan feeds the write from — so the list cannot promise one
     thing and the command do another. The house Tooltip (immediate by default,
     never a native title=) renders them through its `tip` snippet, since the
     content is markup rather than a string. -->
{#snippet retypeItem(it)}
  {#if it.coercions.length === 0}
    <span>{it.label}</span>
  {:else}
    <Tooltip placement="bottom">
      {#snippet tip()}
        <strong>Warning — types will be coerced</strong>
        <ul class="retype-warn-list">
          {#each it.coercions as c (c.key)}
            <li>{c.label}: {c.from} → {c.to}</li>
          {/each}
        </ul>
      {/snippet}
      <span class="retype-coerces">
        <iconify-icon icon="mdi:alert" width="13" height="13"></iconify-icon>
        {it.label}
      </span>
    </Tooltip>
  {/if}
{/snippet}

<!-- (THE WIDGET-TYPE CONTROL used to be a `widgetType` SNIPPET here — a
     panel-wide Dropdown, or a small dim caption when the type was fixed, both
     sitting OUTSIDE the row grid between the item picker and the Name row.
     R6-6 folded it into the Universal section as an ordinary select row, which
     is what makes it the same width as every other property editor; its
     not-retypeable form is now the row grid's own `.disabled-val`. See
     universalCategory in the script and the `optionsFrom: "retype"` branch of
     valueControl — between them they say everything that comment said.) -->
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
  <!-- KEYFRAMABILITY IS PER ROW AS WELL AS PER CONTEXT. `keyframes` (the opts
       flag) says whether this CONTEXT keyframes at all — a transition's config
       rows and a not-yet-created item's grayed rows do not. `row.keyframes:
       false` says this ONE ROW does not, inside a context that otherwise does:
       the Universal section holds Visible (keyframeable) beside Widget type and
       Name (not, today), and one opts object serves all three.
       R6-6.7 RULED THAT WIDGET TYPE *IS* A KEYFRAMEABLE PROPERTY — `type` is
       already carried per-slide by the fold, and only web/app.svelte.js's
       #creationState treats it as identity. So this flag is exactly the seam
       that ruling needs: dropping `keyframes: false` from the type row, once
       the retype command writes at the CURRENT slide, is the whole UI change.
       Nothing else here special-cases the row. -->
  {@const rowKeyframes = keyframes && row.keyframes !== false}
  {@const itemMode = rowKeyframes && !disabled}
  <!-- An ACTION row is a command trigger, not a property: it owns no state, so
       it has no equation path to copy and nothing to keyframe. Both affordances
       are withheld here rather than inside valueControl, because both live in
       THIS snippet's grid cells. -->
  {@const isAction = rowKind(row) === ACTION_ROW_KIND}
  {@const pathText = isAction ? null : pathTooltipText(pathState ?? state, itemId, writeKey(row))}
  {@const helpText = row.help ?? null}
  <!-- THE GALLERY ROW ASPECT (web/GalleryPopup.svelte, plugins/iconify.js's
       `gallery` declaration): a row naming a spec-factory function gets a
       gutter button that opens the shared tile-grid/search picker anchored
       under it. ITEM MODE ONLY, single selection: a not-yet-created row has
       nothing live to open a picker ON, and a multi-selection has no single
       "the" item's current icon to seed the grid's selected tile.

       THIS IS THE ONLY REMAINING GUTTER AFFORDANCE OF ITS KIND, and it stays
       (manifest R6-4's audit result). A gallery is a PER-PROPERTY PICKER: it
       enters no canvas mode and writes only `row.key`, so it edits this row's
       stored value the way every other field control does. Its former
       neighbour, the light-position eyedropper, entered a sustained canvas
       mode and wrote a PAIR of keys — a tool, not a property — and is now the
       Tools pane's "Pin Light Position to an Object" (manifest R6-4.5). If a
       future row aspect wants this gutter, that is the test it has to pass. -->
  {@const gallery = itemMode && !multi ? row.gallery : null}
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
  {@const writePaths = multi ? multiPaths(writeKey(row)) : null}
  {@const ctx = { itemMode, disabled, onpreview, oncommit, itemId, resolvedMax, hoverPreview, writePaths }}
  <!-- TIER 0 (manifest field-resolution rule): does this row get the universal
       `=` fallback, is it showing it, and what does it actually STORE (the raw
       value — the specialized editors receive the EVALUATED one, where an
       equation has already resolved to a color/boolean/string). -->
  {@const eqCapable = equationCapable(row, itemMode)}
  {@const eqStored = eqCapable ? rowStored(row) : null}
  {@const eqActive = eqCapable && equationActive(row, eqStored)}
  {@const eqRowPaths = eqCapable ? (multi ? multiPaths(writeKey(row)) : [["items", pickedItemId, ...writeKey(row).split(".")]]) : null}
  <!-- IS THE ƒ ENTRY OPEN ON THIS ROW, from the button rather than from a stored
       equation? Only this half of `equationActive` may outrank the MIXED mark: a
       mixed row whose PRIMARY happens to store an equation is still MIXED and
       must keep saying so, but a row the user just clicked ƒ on must show the
       field they asked for. Same (key, owner) pair equationActive tests, named
       once so the two readers cannot drift. -->
  {@const eqEntryOpen = eqCapable && eqOpenKey === row.key && eqOwnerId === pickedItemId}
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
    {#if pathText != null || helpText != null || gallery}
      <span class="row-label-chrome">
        {#if pathText != null}
          {@const copied = justCopiedKey === row.key}
          <Tooltip text={copied ? "Copied!" : "Copy equation path"}>
            <button
              class="copy-path-btn"
              aria-label={copied ? `Copied path for ${row.label}` : `Copy equation path for ${row.label}`}
              onclick={() => copyPath(pathState ?? state, itemId, writeKey(row))}
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
        {#if gallery}
          {@const galleryOpen = galleryOpenFor?.itemId === itemId && galleryOpenFor?.key === row.key}
          <Tooltip text={galleryOpen ? "Close gallery" : `${row.label}: browse a gallery`}>
            <button
              class="gallery-btn"
              aria-label={galleryOpen ? "Close gallery" : `${row.label}: browse a gallery`}
              aria-pressed={galleryOpen}
              onclick={(e) => toggleGallery(row, state, itemId, e.currentTarget)}
            >
              <iconify-icon icon="mdi:view-grid-outline" width="13" height="13"></iconify-icon>
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
    {:else if multiRow?.mixed && !eqEntryOpen}
      <!-- MIXED. The user's spec: "a dot dot dot in the parts that are different.
           And then when I click them, it would have to unify them all to the same
           value." The mark sits IN the value cell — the field's own footprint —
           rather than as an extra button beside it, because a per-field mode
           BUTTON was built once and vetoed. One click unifies (ONE undo unit) and
           the real field takes over, already editing all N together.

           IT SITS INSIDE .numfield, WITH THE ƒ, because Tier 0 admits no
           exceptions and a set is not one — this file says so at eqPaths above
           ("a multi-selection keeps the universal `=` affordance instead of
           losing it"), and until this branch was wrapped it said it while doing
           the opposite: the mark short-circuited the `eqCapable` branch, so ƒ was
           unreachable on a mixed row of EVERY kind and the only way to bind a set
           to an expression was to unify to a LITERAL first and then replace it —
           two undo units, the first one destroying whatever the items held.
           `eqRowPaths` is already every selected item's path, and commitEquation
           fans out over it in ONE commit, so writing the equation to all N needs
           no machinery beyond letting the button render.

           THE TOGGLE IS UNPRESSED HERE whatever the primary stores. `aria-pressed`
           is a claim about the ROW, and a mixed row is by definition not on one
           equation; pressing it would also mean the click ran dropEquation —
           stamping the primary's evaluated literal over the others — which is a
           unify wearing an equation button's clothes. Unpressed, the click is
           beginEquation, which writes nothing until commit. -->
      <div class="numfield">
        {#if eqCapable}{@render eqToggle(row, eqRowPaths, false)}{/if}
        <Tooltip text={`${multiPanel.itemIds.length} selected items differ here — click to set them all to ${multiValueLabel(multiRow.seed)}`}>
          <button class="mixed-unify" aria-label={`${row.label}: differs across the selection — unify to ${multiValueLabel(multiRow.seed)}`} onclick={() => unifyRow(multiRow)}>
            {MIXED_MARK}
          </button>
        </Tooltip>
      </div>
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
    {#if rowKeyframes && !disabled && !isAction}
      <span class="kf-controls">
        <KeyframeControls {app} path={["items", itemId, ...writeKey(row).split(".")]} paths={writePaths} />
      </span>
    <!-- THE PURGE TRASH-CAN, on the row that declares `purge` (the Universal
         section's Name row, and only it). Manifest Round 12: "trash can icon…
         same row as the name… so that we don't confuse them with properties".
         It takes the trailing cell rather than a new one, exactly as it did
         while the Name row was a loose div — that cell is the row's TRAILING
         CONTROLS column (app.css: "the trailing controls are auto"), which
         holds the keyframe triad on a keyframeable row and is otherwise empty
         air. A row cannot declare both: `purge` only reaches here when the row
         is not keyframing, which is the Name row's permanent condition (a name
         is not per-slide state). -->
    {:else if row.purge}
      <span class="kf-controls name-actions">
        <Tooltip text="Purge — remove from every slide, keyframes and all">
          <button class="btn-icon danger" aria-label="Purge item" onclick={() => app.runCommand("purge-item")}>
            <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
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
             caveat. THE FRAME COMES FROM core/commands.unavailableMessage, which
             is the only place it is spelled: this row was the FOURTH pane to have
             hand-transcribed "Unavailable — requires {reason}" (Toolbar,
             ToolsPane and CommandPalette were the other three), and four copies
             of one sentence are four chances to disagree. Same shape as
             connectivity's offlineMessage — one function, one condition, one
             sentence, pinned by a test. The clause still comes from
             commandUnavailableReason and never from `cmd.requires`, which may be
             a FUNCTION whose source text would render verbatim. -->
        {#if reason}<div class="tool-tip-requires">{unavailableMessage(reason)}</div>{/if}
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
           equationCapable() above already uses.

           `row.centerAxis` (cx/cy, core/properties.js positioning bundle): the
           row DISPLAYS as "cx"/"cy" (row.key — unique, so multiByKey/undo/
           multiselect bookkeeping never collide with the real x/y row) but
           READS/WRITES through `writeKey(row)`, which PROPS.cx/.cy set to the
           real stored slot ("x"/"y") — that is why `path` below is built from
           writeKey, not row.key. The only extra wiring beyond an ordinary
           number row is `centerAxis`, the item-aware unit transform. See
           NumericField's header. -->
      <NumericField
        {app}
        path={["items", pickedItemId, ...writeKey(row).split(".")]}
        paths={writePaths}
        label={row.label}
        min={row.min ?? null}
        max={resolvedMax}
        scrubMin={row.scrubMin ?? null}
        scrubMax={row.scrubMax ?? null}
        display={row.display ?? null}
        scrub={row.scrub ?? null}
        step={row.step ?? null}
        centerAxis={row.centerAxis ?? null}
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
    <!-- `optionsFrom` names a set this row's options are DERIVED from rather than
         declared with — an unbounded list the plugin cannot enumerate. Both such
         sets type-to-filter through the SAME src/lib/SearchableDropdown (Round 2
         #29), which is also the only reason the retype roster is usable: it is
         the whole widget registry, and R6-26 will grow the same shape into
         "morph from widget" over every property at arbitrary depth.
           "items"  — every eligible widget in the doc (a bento/telescope target).
           "retype" — every type THIS widget can become (core/retype.retypeChoices).
         Enum/grouped selects (blendMode's liked family sections, curve, …) stay
         the plain Dropdown: they are short and `optionGroups` caption inserts
         don't survive a flat fuzzy filter. Every branch shares every other prop. -->
    {#if row.optionsFrom === "items"}
      <SearchableDropdown
        rankFn={appRankItems}
        onpreview={hoverPreview ? (v) => hoverPreview(row.key, "select", v) : undefined}
        oncancelpreview={hoverPreview ? () => app.cancelPreview() : undefined}
        items={allDocumentItems(app.doc)
          .filter((it) => it.id !== itemId && app.registry.get(it.type)?.capabilities.purgeable !== false)
          .map((it) => ({ value: it.id, label: it.name ?? itemFallbackName(app.registry.get(it.type).title, it.id) }))}
        value={valueAt(state, row.key)}
        onchange={(v) => oncommit(row.key, "select", v)}
      />
    {:else if row.optionsFrom === "retype"}
      <!-- THE WIDGET-TYPE ROW. `retypeMenu` is app.retypeChoices() — clean types
           first, coercing types last, each carrying the coercion list its
           `retypeItem` row renders as a warning.
           NO HOVER PREVIEW, deliberately, and it is the one select row without
           one: previewing a retype would have to run the whole coercion plan
           against the live document on every pointer move, which is a WRITE
           shaped like a preview. Every other select stages one property.
           AN EMPTY MENU IS NOT AN EMPTY DROPDOWN. retypeChoices() returns [] for
           the camera, a group and the scene-structural types — the type really is
           fixed there — so the row shows the plugin's title as an inert grayed
           value, the same `.disabled-val` idiom a not-yet-created item's rows and
           an inert list field already use. Offering a menu that refuses every
           choice is a lie; showing an empty one is the same lie with no options. -->
      {#if retypeMenu.length > 0}
        <SearchableDropdown
          rankFn={appRankItems}
          items={retypeMenu}
          value={valueAt(state, row.key)}
          onchange={(v) => oncommit(row.key, "select", v)}
          item={retypeItem}
        />
      {:else}
        <input type="text" class="disabled-val" value={app.registry.get(valueAt(state, row.key))?.title ?? ""} disabled />
      {/if}
    {:else}
      <Dropdown
        onpreview={hoverPreview ? (v) => hoverPreview(row.key, "select", v) : undefined}
        oncancelpreview={hoverPreview ? () => app.cancelPreview() : undefined}
        items={selectRowItems(row)}
        value={valueAt(state, row.key)}
        onchange={(v) => oncommit(row.key, "select", v)}
      />
    {/if}
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
         (OFF | solid | linear/radial gradient | material | equation). A solid
         delegates to ColorField verbatim (byte-identical to before); a gradient
         stores a {type,stops,geometry} object at the SAME item path. Same commit
         contract.
         `offMeans` is a DECLARATION field, forwarded like every other: the row
         says what its OFF state means in that slot ("hollow" on a shape, "keep the
         artwork's own colours" on an SVG), so the strip's Off tooltip is
         slot-accurate without the Inspector knowing any slot's name. Absent →
         PaintField's generic sentence. -->
    <PaintField
      {app}
      path={["items", pickedItemId, ...row.key.split(".")]}
      paths={writePaths}
      label={row.label}
      value={valueAt(state, row.key)}
      disabled={disabled}
      strokeMaterials={row.key === "stroke"}
      offMeans={row.offMeans ?? null}
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
      <!-- Plain boolean (grayed item display / transition config / a boolean whose
           write is a COMMAND rather than a keyframe): a simple toggle committing
           directly through oncommit.
           `onText`/`offText` are honoured HERE TOO, not only in itemMode's
           BooleanField: the tooltip says what CLICKING DOES in the state the
           control is currently in, and that sentence is a fact about the row, not
           about which write path renders it. Withholding it here was how the
           not-yet-created Visible row ended up hand-built outside the row grid
           just to keep its "click to show it here, copying its properties onto
           this slide" tip. A row that declares neither gets no tooltip, exactly
           as before — the label-echo tooltip stays banned. -->
      {@const boolOn = Boolean(valueAt(state, row.key))}
      <!-- "" (not null) is the no-tooltip value: Tooltip gates on text.length. -->
      {@const boolTip = (boolOn ? row.onText : row.offText) ?? ""}
      <div class="boolfield">
        <Tooltip text={boolTip}>
          <button
            class="boolbtn"
            class:on={boolOn}
            aria-label={row.label}
            aria-pressed={boolOn}
            {disabled}
            onclick={() => oncommit(row.key, "boolean", !boolOn)}
          >
            <iconify-icon icon={boolOn ? (row.onIcon ?? "mdi:check") : (row.offIcon ?? "mdi:checkbox-blank-outline")} width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
      </div>
    {/if}
  {:else if kind === "richtext"}
    <!-- A STRUCTURED value with a PLAIN-TEXT surface (R6-13.3). The row exists
         because the property is perfectly ordinary — items.<id>.text is
         {runs, paras} like any other stored value — and the user simply could not
         SEE it: text was the only content-bearing widget with no content row,
         while mermaid, latex, codeblock, graph_line and graph_bars all ship one.

         WHY IT CANNOT BE kind:"text". The catch-all below writes e.target.value
         straight through, so an OBJECT-valued row would render "[object Object]"
         and the first keystroke would replace {runs, paras} with a bare string.
         That is why this branch and `richtext`'s entry in ROW_KINDS are one
         commit: the kind existing without the branch is strictly worse than the
         row not existing at all.

         THE WRITE IS A MINIMAL SPLICE, not a flatten. core/richtext.js's
         withPlainTextReplaced diffs old plain against new plain in CODE POINTS
         and routes the difference through deleteRange + insertText, so every run
         style OUTSIDE the changed span survives — editing "Big small" to
         "Bigger small" keeps 48pt on "Bigger" and 18pt on "small". Its one
         documented bound: replacing a run's text ENTIRELY leaves no character to
         carry that run's style, so the replacement inherits the splice-point
         neighbour's — the same thing selecting that word on the canvas and
         retyping it does.

         SPLICING AGAINST THE PREVIEW-BLENDED `state` IS CORRECT, and the reason
         is worth stating because it looks like a bug. `valueAt` is re-read per
         keystroke, so the base advances with the gesture — but `e.target.value`
         is always the WHOLE new text, and the diff is minimal-prefix/suffix, so a
         base that is stale by a keystroke yields a wider splice with the same
         result. Both a stable and an advancing base project to exactly what the
         input shows; no focus-time capture is needed.

         NO ƒ. `richtext` is deliberately out of EQUATION_KINDS because
         core/expressions.js refuses equations on text values, so an equation
         affordance here would be a control lying about what it is. -->
    <input
      type="text"
      data-hint-scope="revert"
      value={richTextToPlain(valueAt(state, row.key))}
      {disabled}
      oninput={(e) => onpreview(row.key, kind, withPlainTextReplaced(valueAt(state, row.key), e.target.value))}
      onchange={(e) => oncommit(row.key, kind, withPlainTextReplaced(valueAt(state, row.key), e.target.value))}
      onkeydown={fieldKeydown}
    />
  {:else}
    <!-- `placeholder` is what the row shows when it stores NOTHING and something
         else supplies the value — the Name row's positional fallback name
         (app.displayName), which is what the item picker and the outline call an
         unnamed widget. Absent on every other text row, where empty means empty. -->
    <input
      type="text"
      data-hint-scope="revert"
      value={state[row.key] ?? ""}
      placeholder={row.placeholder ?? null}
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
      data-hint-scope="commit"
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
        <!-- The divider belongs to THE CATEGORY, not the panel: "only visually
             shown and clickable in between the drop-down areas for formatting
             and stroke material, etc." (user, verbatim). A category's expanded
             rows are exactly the region where a label⟷value boundary exists, so
             the strip spans that and stops. It used to span the whole .rows
             block, which also covered the section HEADERS, the Name row and the
             not-created note — regions with no value column at all, where the
             strip was a col-resize cursor over text that has no column to
             resize. Collapse a category and its divider goes with it, which is
             the same rule stated from the other side.

             AND ONE PER RUN, not one per category (rowRuns above): a FULL-WIDTH
             row — a gradient paint stack, a list's second line — has no boundary
             either, so a single category-wide strip ran straight through its mode
             strip and preset library. That was the user's "that line is still
             extending too far down… visually going past the stroke material
             area". Each boundary run gets its own segment and a full-width row
             gets none; PaintField mounts its own around the sub-rows inside its
             stack. Every segment is positioned from the one --a-label-frac, so
             splitting the strip does not desynchronize it. -->
        {#each rowRuns(cat.rows) as run (run.rows[0].key)}
          {#if run.boundary}
            <div class="cat-row-run">
              {@render labelDivider()}
              {#each run.rows as row (row.key)}
                {@render propRow(row, state, opts)}
              {/each}
            </div>
          {:else}
            {#each run.rows as row (row.key)}
              {@render propRow(row, state, opts)}
            {/each}
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="inspector">
  <div class="inspector-head">
    <!-- The item picker lists EVERY object on EVERY slide (Round 2 #29: object
         select becomes searchable) — unbounded, so it types-to-filter past the
         small-list threshold. It keeps its custom `pickerItem` snippet (the
         invisible-on-this-slide danger styling), which opts out of the built-in
         match highlight. -->
    <!-- HOVER PREVIEWS THE SELECTION BOX (user, 2026-08-01: "it should preview,
         just like many other things preview, the selection box so that I can see
         which element is being selected"). This list is names, and a name is not
         a location — every OTHER dropdown in this file already previews its
         effect on hover (the row above passes onpreview/oncancelpreview into the
         property Dropdowns), so the one picker whose whole job is "which object
         do you mean" was the one that answered with nothing. It sets
         app.hoverItemId rather than app.selection: hovering must not fire every
         selection-dependent effect in the app. -->
    <SearchableDropdown
      rankFn={appRankItems}
      items={itemChoices}
      value={pickedItemId}
      placeholder="— select item —"
      onpreview={(v) => (app.hoverItemId = v)}
      oncancelpreview={() => (app.hoverItemId = null)}
      onchange={(v) => { app.hoverItemId = null; app.selection = v; }}
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
        <Tooltip text="Hide every selected item on this slide">
          <button class="btn" onclick={() => app.runCommand("delete-item")}>
            <iconify-icon icon="mdi:eye-off" width="16" height="16"></iconify-icon>
            Hide all
          </button>
        </Tooltip>
        <!-- BOTH explicit set-actions, never a mixed-state guessing toggle
             (user ruling: "hide all... didn't turn into show all"). Show all
             activates every selected item here; not-yet-created items follow
             the ratified creation-state-copy semantics. -->
        <Tooltip text="Show every selected item here — a not-yet-created one is created here">
          <button class="btn" onclick={() => app.runCommand("show-item")}>
            <iconify-icon icon="mdi:eye" width="16" height="16"></iconify-icon>
            Show all
          </button>
        </Tooltip>
        <!-- Leads with the WORD: "purge" is this app's specific term for
             destroy-everywhere, the counterpart to Delete's deactivate-on-this-
             slide. A tooltip that only paraphrases it never teaches it. -->
        <Tooltip text="Purge — remove every selected item from every slide">
          <button class="btn danger" aria-label="Purge selected" onclick={() => app.runCommand("purge-item")}>
            <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
      </div>
      <!-- INTERSECTION ⇄ UNION, at the very top because the user put it there:
           "on the very top it should let me say intersection or union". It
           decides WHICH ROWS the panel below is made of, so it reads before them
           rather than after. Intersection is the default and is byte-identical to
           the shipped behaviour: rows every selected item has. Union adds the
           rows only some of them have — those still edit, keyframe, show "…" and
           unify exactly the same way ("same behaviour for both"); they simply
           apply to the items that declare them, which the row's own count says. -->
      <!-- THE ICONS ARE VENN DIAGRAMS, and they are the SAME diagram with a
           different region filled — mdi's own `set-*` family, so the pair reads as
           one picture answering "which region of the two sets?" rather than two
           unrelated glyphs. mdi:set-center fills the LENS (what both share);
           mdi:set-all fills BOTH circles (everything either has). That is exactly
           the distinction the toggle makes, which is why an icon is worth having
           here at all. The words stay: "intersection"/"union" is set vocabulary
           the user reached for, but an icon-only control for it would be a
           guessing game for anyone who did not name it themselves. -->
      <div class="multi-mode" role="group" aria-label="Which properties to show">
        {#each [["intersection", "Shared", "mdi:set-center", "Only properties EVERY selected item has, so a change here reaches all of them. The safe default."], ["union", "All", "mdi:set-all", "Every property ANY selected item has. A property only some of them have still edits, keyframes and unifies the same way — it just applies to the ones that have it."]] as [mode, label, icon, tip] (mode)}
          <Tooltip text={tip}>
            <button
              class="btn"
              class:active={multiPanel.mode === mode}
              aria-pressed={multiPanel.mode === mode}
              onclick={() => app.setMultiSelectMode(mode)}
            >
              <iconify-icon {icon} width="14" height="14"></iconify-icon>
              {label}
            </button>
          </Tooltip>
        {/each}
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
      <!-- SHARED-LOOKING BUT NOT SHARED. A key both items declare with a DIFFERENT
           contract (a rect's corner radius is a length, a star's is a 0..0.5
           fraction; a magnifier's `shape` offers circle/box where the shape widget
           offers twenty silhouettes).
           IT USED TO BE EXCLUDED. The user overruled that (#300): "I realise they
           may mean different things… but don't actually BLOCK me from doing it.
           There should be a way to get around that." So the row is now OFFERED —
           marked with the same … every mixed row carries, unifying on a click to
           the value THIS panel is showing — and this note stays as the warning
           that says WHICH aspect disagrees. Informing and allowing are not
           alternatives, and the refusal was the half that had no escape hatch. -->
      {#if multiPanel.conflicts.length > 0}
        <div class="multi-note">
          These mean different things here — editing one sets them all (click the … to unify):
          {#each multiPanel.conflicts as c (c.key)}
            <Tooltip text={`These items disagree about this property's ${c.aspects.join(", ")}, so one value will not mean the same thing to all of them — a corner radius that is a LENGTH on one widget and a FRACTION on another will visibly jump. The row is still editable: unifying writes the value this panel is showing (the primary item's) to every selected item. Nothing stops you; this is the warning, not a refusal.`}
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
      <!-- SLIDE NAME (Round 4 #54): the boundary panel is the slide's
           properties surface, so the name is editable HERE as well as by
           double-clicking it in the navigator. Commit on change (ONE undo
           unit); blank restores the positional default. -->
      {@const nameSlideIndex = app.doc.slides.findIndex((s) => s.id === transitionSlideId)}
      {#if nameSlideIndex >= 0}
        <div class="row">
          <span class="label">Name</span>
          <input
            class="slide-name-field"
            value={app.doc.slides[nameSlideIndex].name}
            onchange={(e) => app.renameSlide(nameSlideIndex, e.target.value)}
            aria-label={`Slide ${nameSlideIndex + 1} name`}
          />
          <span class="kf-controls" aria-hidden="true"></span>
        </div>
      {/if}
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
    <div class="rows">
      <!-- THE UNIVERSAL SECTION — Name, Widget type, Visible, in that order, as
           three ORDINARY rows in ONE accordion (R6-6.6), FIRST because they are
           the properties every widget has and the plugin's sections are what it
           adds to them.
           It replaces three different shapes doing the same job: a small dim
           CAPTION for the type, a loose `.row.name-row` div outside the sections,
           and a loose Visible propRow. That mix is exactly what the user reported
           — the type control was panel-wide where every property editor is value-
           column-wide, and the Name label sat two gutter slots left of every
           other label in the panel because it rendered a bare span with none of
           the row's label chrome. Going through `category` also hands the section
           its collapse memory and its label⟷value divider for free.
           The camera keeps its old behaviour without a branch here: it is
           purgeable:false, so `universalCategory` drops the Visible row and the
           Name row's purge, and retypeChoices() is empty for it so the type row
           renders its title inert. -->
      {@render category(universalCategory, universalState, {
        keyframes: true,
        disabled: false,
        onpreview: previewUniversal,
        oncommit: commitUniversal,
        itemId: sel.itemId,
        pathState: app.rawState(),
        // hoverPreview: this CREATED-item context previews without committing.
        // (Neither Visible nor the two command-backed rows uses it — Widget type
        // opts out inside valueControl for a reason of its own — but the field is
        // threaded so both created-item contexts are identical.)
        hoverPreview: previewField,
      })}
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
      <!-- PER-ITEM VARIABLES (manifest item 67): the selected widget's OWN
           keyframable vars, referenced as `self.vars.<name>`. A collapsible
           accordion like every category, keyed apart from the plugin categories
           so its collapse state is its own (a plugin cannot own the id
           "__itemvars"). Purgeable gate matches the visibility/name rows: the
           camera is not an authorable widget. -->
      {#if purgeable}
        <div class="prop-category">
          <button
            class="cat-header"
            aria-expanded={!collapsed.__itemvars}
            onclick={() => toggleCategory("__itemvars")}
          >
            <iconify-icon icon={collapsed.__itemvars ? "mdi:chevron-right" : "mdi:chevron-down"} width="16" height="16"></iconify-icon>
            <span class="cat-title">Variables</span>
          </button>
          {#if !collapsed.__itemvars}
            <div class="cat-rows">
              <ItemVariablesPanel {app} itemId={sel.itemId} />
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else if pickedItemId != null && creationState}
    <!-- NOT YET CREATED on this slide (manifest Round 12B): show ALL its normal
         property rows GRAYED/disabled (values from its creation slide), but keep
         the VISIBILITY row ACTIONABLE ("otherwise it's useless"). Toggling it ON
         runs activateNotYetCreated() — writes the item's creation-slide state +
         active:true onto THIS slide (lead ruling). The visibility row shows OFF
         (the item does not exist here yet). Name + Purge still act. -->
    <div class="rows">
      <!-- THE SAME UNIVERSAL SECTION the created branch renders, and that is the
           point: an item that does not exist on THIS slide still has a type, a
           name and a visibility, and both branches must label them identically or
           one of them is the branch that forgets. It stays LIVE (disabled:false)
           while the plugin categories below are grayed, exactly as the loose Name
           row and the actionable Visible button it replaces did — those two are
           the whole reason this branch exists ("otherwise it's useless").
           keyframes:false because nothing here can be keyframed yet: the type row
           has no menu (retypeChoices reads state this item has none of), the name
           is not per-slide, and the Visible toggle CREATES the item rather than
           keying a boolean — universalCategory/commitUniversal own those three
           differences so this call site states none of them. -->
      {@render category(universalCategory, universalState, {
        keyframes: false,
        disabled: false,
        onpreview: previewUniversal,
        oncommit: commitUniversal,
        itemId: pickedItemId,
        pathState: allItemsState,
      })}
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

<!-- ONE popup instance for the whole panel (not one per row): galleryOpenFor
     names which row owns it, so switching rows/items or a repeat click on the
     same button closes it via toggleGallery — see the script section above. -->
{#if galleryOpenFor && gallerySpec}
  <GalleryPopup
    spec={gallerySpec}
    anchorEl={galleryAnchorEl}
    bind:open={galleryPopupOpen}
    onpick={(value) => commitGalleryPick({ key: galleryOpenFor.key }, galleryOpenFor.itemId, value)}
  />
{/if}
