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
-->
<script>
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import DraggableNumber from "../../../lib/DraggableNumber.svelte";
  import NumericField from "./NumericField.svelte";
  import BooleanField from "./BooleanField.svelte";
  import ColorField from "./ColorField.svelte";
  import { allDocumentItems, keyframeIndices, foldState } from "../core/document.js";
  import { transitionInspector, TRANSITION_TYPES } from "../core/transitions.js";

  let { app } = $props();

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
        label: it.name ?? `${app.registry.get(it.type).title} (${it.id.slice(0, 4)})`,
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
  // Number of selected items — >1 shows the minimal multi-select placeholder
  // (the full intersection Property Panel is a SEPARATE milestone; manifest).
  let selCount = $derived(app.selectedIds().length);

  // NOT-YET-CREATED display state: the item's FULL folded property set as of its
  // ORIGINAL creation slide (manifest Round 12B — grayed rows show the item
  // "looking like itself", not bare defaults). null until we have a picked item
  // with a known creation slide.
  let creationState = $derived.by(() => {
    if (sel || pickedItemId == null || creationIndex == null) return null;
    return foldState(app.doc, creationIndex, 1).items?.[pickedItemId] ?? null;
  });

  // ── Category accordion ────────────────────────────────────────────────────
  // Row defs carry a `category` key (manifest Round 12). Uncategorized rows fall
  // into DEFAULT_CATEGORY. Category display titles + order are here; unknown
  // categories (future plugins) append after the known ones, titled by a
  // start-cased fallback.
  const DEFAULT_CATEGORY = "other";
  const CATEGORY_TITLES = {
    positioning: "Positioning",
    formatting: "Formatting",
    text: "Text",
    arrow: "Arrow",
    lens: "Lens",
    blur: "Blur",
    other: "Other",
  };
  const CATEGORY_ORDER = ["positioning", "formatting", "text", "arrow", "lens", "blur", "other"];

  /** Pure function. Groups plugin inspector rows into ordered category buckets:
   * [{id, title, rows}]. Preserves row order within a category; known
   * categories sort by CATEGORY_ORDER, unknown ones append in first-seen order.
   *
   * Examples:
   *     >>> // rows [{key:"x",category:"positioning"},{key:"fill",category:"formatting"}]
   *     >>> // → [{id:"positioning",title:"Positioning",rows:[…x]},{id:"formatting",…}]
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

  // ── Value coercion / path read ───────────────────────────────────────────────
  // Color hex parsing/normalization/composition now lives in ColorField.svelte
  // (the SvelteLib ColorPicker owns the picking; ColorField owns the hex round-
  // trip). The old normalizedHex/rgbHex/alphaOf/composedHex/commitHexField and
  // the hexEditing/hexDraft draft state died with the native-input color row.

  function coerce(kind, raw) {
    return kind === "number" ? Number(raw) : kind === "checkbox" ? Boolean(raw) : raw;
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

  function fieldKeydown(e) {
    if (e.key === "Escape") {
      app.cancelPreview();
      e.target.blur();
      e.stopPropagation();
    }
  }

  function toggleKey(key) {
    // Dotted keys are nested paths (arrow "from.x"). Inserting a keyframe copies
    // the RAW stored value — an equation keyframes as the equation.
    const path = key.split(".");
    if (app.hasKey(key)) app.removeKey(app.slideIndex, ["items", pickedItemId, ...path]);
    else app.keyframePath(["items", pickedItemId, ...path], app.storedItemValue(pickedItemId, path));
  }

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
     transition props). -->
{#snippet propRow(row, state, { keyframes = true, disabled = false, onpreview, oncommit })}
  <!-- ITEM MODE (keyframes && !disabled): equation-aware NumericField + keyframe
       diamonds, writing item property keyframes. Otherwise PLAIN MODE: a not-yet-
       created item's grayed display (disabled) or a transition's config rows
       (keyframes:false) — plain inputs committing directly via onpreview/oncommit,
       no equations, no diamonds. -->
  {@const itemMode = keyframes && !disabled}
  <div class="row" class:row-disabled={disabled}>
    <Tooltip text={row.label}>
      <span class="label">{row.label}</span>
    </Tooltip>
    {#if row.kind === "number"}
      {#if itemMode}
        <!-- NumericField: equation-aware (THE UNIFICATION). A number renders as
             the DraggableNumber scrubber; an equation as a monospace expression
             editor with live evaluation + error affordance. Click-without-drag
             opens text entry; typed content decides number vs equation.
             `display` (e.g. "degrees") edits/shows in a unit different from
             storage. Dotted keys ("from.x") = nested state. -->
        <NumericField
          {app}
          path={["items", pickedItemId, ...row.key.split(".")]}
          label={row.label}
          min={row.min ?? null}
          max={row.max ?? null}
          display={row.display ?? null}
        />
      {:else if disabled}
        <!-- Grayed display of a not-yet-created item: read the value straight
             from the creation-fold state; no equation/scrub affordance. -->
        <input type="text" class="disabled-val" value={String(valueAt(state, row.key) ?? "")} disabled />
      {:else}
        <!-- Plain number (transition config): a bounded DraggableNumber scrubber
             that commits directly (no equations, no keyframes). -->
        <div class="numfield">
          <DraggableNumber
            label={row.label}
            value={Number(valueAt(state, row.key) ?? 0)}
            min={row.min ?? null}
            max={row.max ?? null}
            oninput={(n) => onpreview(row.key, row.kind, n)}
            onchange={(n) => oncommit(row.key, row.kind, n)}
          />
        </div>
      {/if}
    {:else if row.kind === "select"}
      <!-- Enum dropdown (transition `curve`; new control kind, flagged by Opus9).
           SvelteLib Dropdown over the row's `options`, filling the value column.
           Only reached for transition rows today (never disabled); Dropdown has
           no top-level disabled prop, so a future disabled select would render
           the plain grayed value instead. -->
      <Dropdown
        items={(row.options ?? []).map((o) => ({ value: o, label: o }))}
        value={valueAt(state, row.key)}
        onchange={(v) => oncommit(row.key, "select", v)}
      />
    {:else if row.kind === "asset"}
      <!-- Nullable asset reference (transition `sound`; new control kind, flagged
           by Opus9). The asset PICKER is a later wave (assets server is parallel
           work), so this is a plain nullable text field placeholder — empty text
           commits null. It round-trips the stored ref meanwhile. -->
      <input
        type="text"
        placeholder="(none)"
        value={valueAt(state, row.key) ?? ""}
        {disabled}
        onchange={(e) => oncommit(row.key, "asset", e.target.value.trim() === "" ? null : e.target.value.trim())}
        onkeydown={fieldKeydown}
      />
    {:else if row.kind === "color"}
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
        label={row.label}
        value={valueAt(state, row.key)}
        disabled={disabled}
      />
    {:else if row.kind === "checkbox" || row.kind === "boolean"}
      {#if itemMode}
        <!-- Standard boolean control (BooleanField): a square toggle whose state
             shows via the icon (never a background fill — toggle ruling). Used for
             `active` (visibility) and plugin booleans like `bold`. Writes an item
             property keyframe on this slide. -->
        <BooleanField
          {app}
          path={["items", pickedItemId, ...row.key.split(".")]}
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
            onclick={() => oncommit(row.key, "checkbox", !valueAt(state, row.key))}
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
        oninput={(e) => onpreview(row.key, row.kind, e.target.value)}
        onchange={(e) => oncommit(row.key, row.kind, e.target.value)}
        onkeydown={fieldKeydown}
      />
    {/if}
    <!-- prev ◆ next — jumps hug the diamond (manifest spec); hollow = not keyed
         on this slide, filled = keyed. Iconify, never Unicode. Grouped in ONE
         .kf-controls span so they occupy a SINGLE grid cell (the row grid's
         trailing auto column). Transitions and grayed rows have no diamonds; the
         empty span still reserves the column so value edges stay aligned. -->
    {#if keyframes && !disabled}
      <span class="kf-controls">
        <Tooltip text="Previous keyframe">
          <button class="jumpbtn" aria-label="Previous keyframe" onclick={() => app.jumpKeyframe(row.key, -1)}>
            <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
        <Tooltip text={app.hasKey(row.key) ? "Remove keyframe on this slide" : "Insert keyframe on this slide"}>
          <button
            class="keybtn"
            class:keyed={app.hasKey(row.key)}
            aria-label="Toggle keyframe on this slide"
            onclick={() => toggleKey(row.key)}
          >
            <iconify-icon icon={app.hasKey(row.key) ? "mdi:rhombus" : "mdi:rhombus-outline"} width="17" height="17"></iconify-icon>
          </button>
        </Tooltip>
        <Tooltip text="Next keyframe">
          <button class="jumpbtn" aria-label="Next keyframe" onclick={() => app.jumpKeyframe(row.key, +1)}>
            <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
      </span>
    {:else}
      <span class="kf-controls" aria-hidden="true"></span>
    {/if}
  </div>
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
    <!-- Minimal multi-select placeholder (manifest: the full intersection
         Property Panel is a SEPARATE milestone — do NOT build it here). Round
         12B unification: singles now surface VISIBILITY as a property row (the
         old "Delete here" ACTION is gone). For a SET, a single visibility toggle
         is the half-filled-diamond problem (mixed visible/hidden state has no
         one correct icon), and "show all" would need per-item creation-state
         activation — both belong to the intersection milestone. So the
         placeholder keeps only the two UNAMBIGUOUS set actions and drops the
         confusing "Delete here" label: HIDE ALL (deactivate every selected item
         on this slide — the existing delete-item command) and PURGE (trash
         icon). This is the chosen mixed-state answer: an explicit set ACTION,
         not a tri-state toggle, until the intersection panel lands. -->
    <div class="multi-select">
      <div class="multi-count">{selCount} items selected</div>
      <div class="item-actions">
        <Tooltip text="Hide every selected item on this slide (keyframes active: false)">
          <button class="btn" onclick={() => app.runCommand("delete-item")}>
            <iconify-icon icon="mdi:eye-off" width="16" height="16"></iconify-icon>
            Hide all
          </button>
        </Tooltip>
        <Tooltip text="Remove every selected item from existence (all slides)">
          <button class="btn danger" aria-label="Purge selected" onclick={() => app.runCommand("purge-item")}>
            <iconify-icon icon="mdi:trash-can-outline" width="16" height="16"></iconify-icon>
          </button>
        </Tooltip>
      </div>
    </div>
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
          <Tooltip text="Remove from existence (all keyframes, all slides)">
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
            offText: "Hidden on this slide — click to show (keyframes active: true)" },
          sel.state,
          { keyframes: true, disabled: false, onpreview: previewField, oncommit: commitField }
        )}
      {/if}
      {#each itemCategories as cat (cat.id)}
        {@render category(cat, sel.state, {
          keyframes: true,
          disabled: false,
          onpreview: previewField,
          oncommit: commitField,
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
          <Tooltip text="Remove from existence (all keyframes, all slides)">
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
          <Tooltip text="Visible"><span class="label">Visible</span></Tooltip>
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
