<!--
  Dropdown [visual, general] — themable single- or multi-select.

  Drop-in replacement for native <select>: pass `items` and bind `value`.
  The menu is constrained to the trigger's width so the two pieces share
  the same silhouette and meld via squared seam corners — no SVG, no
  flare math. Items longer than the trigger truncate with ellipsis;
  size your trigger (e.g. `min-width` on the wrapper) to fit.

  Item shape:
    - Selectable row:  { value:any, label:string, disabled?:boolean }
    - Insert (decoration between rows, generic): { insert: Snippet | string }
      Inserts render BETWEEN item rows without occupying a selectable slot:
      arrow-key navigation skips them, they can't be selected, and they don't
      affect item spacing. By default an insert renders as just its content
      with no decoration (nearly invisible). Opt into a look via the `insert`
      snippet and/or the --dd-insert-* custom properties (e.g. dotted rules).
      The concept is generic; no particular separator style is baked in.

  Multi-select (`multiple`):
    - When false (default): `value` is a single value; clicking a row selects
      it and closes the menu (unchanged legacy behavior).
    - When true: `value` is an array ($bindable); clicking or Enter toggles a
      row's membership WITHOUT closing the menu. The trigger shows a summary
      (default: single label / "N selected" / placeholder when empty — override
      via the `summary(values, items)` prop). Selected rows show a checkmark
      (inline SVG, mdi:check glyph). Passing a non-array `value` with
      multiple:true throws.

  Scroll-on-open (`scrollToValue`):
    - When set, the row whose value === scrollToValue is scrolled into view
      (centered if possible) as the menu opens. Default (unset): no auto-scroll.

  LIVE PREVIEW of the ACTIVE row (`onpreview` / `oncancelpreview`, both optional):
    - Whenever the ACTIVE row changes, `onpreview(value)` fires for the newly
      active row; when nothing is active any more (menu closed, or a non-
      selectable row) `oncancelpreview()` fires. Consumers use this to show what
      an option WOULD do before committing to it — the caller previews, the
      Dropdown only reports which row is under consideration.
    - "Active" is ONE notion driven by BOTH the pointer (hovering a row) and the
      keyboard (↑/↓/Home/End), so hover and arrow-key navigation preview
      identically for free — no separate hover path to drift.
    - It is a PREVIEW, never a commit: `onchange` still fires only on a real
      click/Enter. A consumer whose preview and commit paths are the same
      function must NOT wire it (it would commit on hover).
    - Opening the menu previews the CURRENTLY SELECTED row (that is the row the
      menu opens active on), which is a no-op preview by construction.

  Extensibility hooks:
    - `trigger` snippet — override the closed-state button rendering
    - `item`    snippet — override per-row rendering
    - `insert`  snippet — override per-insert rendering (receives the payload)
    - `header`  snippet — content above the list (search box, etc.)
    - `footer`  snippet — content below the list (action buttons, etc.)

  Behavior: click trigger to open, click item to select/toggle, click outside
  or ESC to close. ↑/↓ to navigate (skipping inserts + disabled rows), Enter to
  select/toggle, Home/End to jump.

  CSS custom properties:
    --dd-bg, --dd-fg, --dd-fg-dim, --dd-border, --dd-radius, --dd-padding,
    --dd-font-size, --dd-hover-bg, --dd-active-bg, --dd-active-fg,
    --dd-menu-shadow, --dd-menu-max-height,
    --dd-caret-size          — trigger caret icon size (default 1.2em ⇒ tracks
                               the trigger's text height; flips 180° on open)
    --dd-caret-color         — caret color (default currentColor)
    --dd-caret-opacity       — caret opacity (default 0.7)
    --dd-check-size          — checkmark icon size in multi-select rows
    --dd-check-color         — checkmark color (defaults to --dd-active-fg)
    --dd-insert-padding      — padding around an insert's content
    --dd-insert-color        — insert content/border color
    --dd-insert-border       — insert border shorthand (unset ⇒ no rule drawn)
-->
<script>
  /* Registers the <iconify-icon> web component for consumer snippets (trigger /
     item) that use it. Our own built-in glyphs below do NOT — see next note. */
  import "iconify-icon";

  /* Built-in glyphs (caret, checkmark) render as inline <svg>, NOT via the
     iconify-icon web component. Reason: iconify-icon's mutation observer
     re-scans and re-renders all instances when the DOM changes; opening a
     sibling dropdown's menu (which mounts icons) was intermittently blanking
     the trigger caret's SVG. Inline SVG is synchronous, offline, and immune to
     that churn — and still "SVG-only" (never a Unicode text glyph, which sizes
     unpredictably). Paths mirror mdi:menu-down / mdi:check on a 24×24 viewBox;
     `currentColor` lets CSS color them. Sized via font-size (1em = 24 units).
     (Row content and consumer snippets may still use iconify-icon freely.) */
  const CARET_PATH = "m7 10l5 5l5-5z"; // mdi:menu-down
  const CHECK_PATH = "M21 7L9 19l-5.5-5.5l1.41-1.41L9 16.17L19.59 5.59z"; // mdi:check

  /**
   * Pure function. True if `it` is an insert entry (decoration between rows)
   * rather than a selectable item. Inserts are discriminated by an `insert`
   * key holding a Snippet or string.
   *
   * @example isInsert({ insert: "—" }) // true
   * @example isInsert({ value: "a", label: "A" }) // false
   */
  function isInsert(it) {
    return it != null && Object.prototype.hasOwnProperty.call(it, "insert");
  }

  /**
   * Pure function. Index of the first selectable item whose value === `value`,
   * or -1. Insert entries are ignored.
   *
   * @example findIndex([{value:"a"},{insert:"-"},{value:"b"}], "b") // 2
   * @example findIndex([{value:"a"}], "x") // -1
   */
  function findIndex(items, value) {
    for (let i = 0; i < items.length; i++) {
      if (!isInsert(items[i]) && items[i].value === value) return i;
    }
    return -1;
  }

  /**
   * Pure function. Modulo that wraps negative results into [0, n).
   *
   * @example wrap(-1, 3) // 2
   * @example wrap(4, 3)  // 1
   */
  function wrap(i, n) {
    return ((i % n) + n) % n;
  }

  /**
   * Pure function. True if the item at `i` is a landable navigation target
   * (exists, is not an insert, is not disabled).
   *
   * @example isSelectable([{value:"a"}], 0) // true
   * @example isSelectable([{value:"a",disabled:true}], 0) // false
   * @example isSelectable([{insert:"-"}], 0) // false
   */
  function isSelectable(items, i) {
    const it = items[i];
    return !!it && !isInsert(it) && !it.disabled;
  }

  /**
   * Pure function. True if `value` (an array of selected values) contains the
   * value of the item at `i`. Safe on inserts (always false).
   *
   * @example isChecked([{value:"a"},{value:"b"}], ["b"], 1) // true
   * @example isChecked([{value:"a"}], ["b"], 0) // false
   */
  function isChecked(items, value, i) {
    const it = items[i];
    if (!it || isInsert(it)) return false;
    return Array.isArray(value) && value.includes(it.value);
  }

  /**
   * Pure function. Toggle `v`'s membership in array `arr`, returning a new
   * array (arr unmutated). Adds if absent, removes if present.
   *
   * @example toggleMembership(["a"], "b") // ["a", "b"]
   * @example toggleMembership(["a","b"], "a") // ["b"]
   */
  function toggleMembership(arr, v) {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  /**
   * Pure function. Default multi-select trigger summary text.
   * Empty ⇒ placeholder; one ⇒ that item's label; many ⇒ "N selected".
   *
   * @example defaultSummary([], [{value:"a",label:"A"}], "Pick") // "Pick"
   * @example defaultSummary(["a"], [{value:"a",label:"A"}], "Pick") // "A"
   * @example defaultSummary(["a","b"], [{value:"a",label:"A"},{value:"b",label:"B"}], "Pick") // "2 selected"
   */
  function defaultSummary(values, items, placeholder) {
    if (!values.length) return placeholder;
    if (values.length === 1) {
      const idx = findIndex(items, values[0]);
      return idx >= 0 ? items[idx].label : String(values[0]);
    }
    return `${values.length} selected`;
  }

  let {
    /** @type {({value:any,label:string,disabled?:boolean}|{insert:any})[]} */
    items = [],
    /** @type {any} single-select: any; multi-select: any[] */
    value = $bindable(undefined),
    /** @type {boolean} when true, value is a $bindable array; rows toggle without closing */
    multiple = false,
    placeholder = "Select…",
    /** @type {any} multi-select only: scroll this value's row into view on open */
    scrollToValue = undefined,
    /** @type {(value:any)=>void} */
    onchange = undefined,
    /** @type {(value:any)=>void} live-preview the ACTIVE row — never a commit */
    onpreview = undefined,
    /** @type {()=>void} revert the live preview (nothing active any more) */
    oncancelpreview = undefined,
    /** @type {(values:any[], items:any[])=>string} multi-select trigger summary */
    summary = undefined,

    trigger,
    item: itemSnippet,
    insert: insertSnippet,
    header,
    footer,
  } = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  let rootEl;
  let listEl = $state(null);

  /* Loud guard: multi-select requires an array value so bindings stay sane. */
  $effect(() => {
    if (multiple && !Array.isArray(value)) {
      throw new Error(
        "Dropdown: multiple:true requires an array `value` (bind:value={[]}), got " +
          (value === undefined ? "undefined" : typeof value),
      );
    }
  });

  const currentItem = $derived(items[findIndex(items, value)]);
  const summaryText = $derived(
    multiple
      ? (summary ?? defaultSummary)(Array.isArray(value) ? value : [], items, placeholder)
      : (currentItem?.label ?? placeholder),
  );

  function firstSelectableFor(value) {
    const idx = findIndex(items, multiple ? undefined : value);
    if (idx >= 0) return idx;
    for (let i = 0; i < items.length; i++) if (isSelectable(items, i)) return i;
    return -1;
  }

  function openMenu() {
    open = true;
    activeIndex = firstSelectableFor(value);
    if (scrollToValue !== undefined) scrollTargetIntoView(scrollToValue);
  }

  function closeMenu() {
    open = false;
    activeIndex = -1;
  }

  function toggleMenu() {
    open ? closeMenu() : openMenu();
  }

  /* Command: scroll the row whose value === target into view, centered.
     Waits a frame so the menu has laid out before measuring. */
  function scrollTargetIntoView(target) {
    const idx = findIndex(items, target);
    if (idx < 0) return;
    requestAnimationFrame(() => {
      const row = listEl?.querySelector(`[data-dd-index="${idx}"]`);
      row?.scrollIntoView({ block: "center" });
    });
  }

  function selectAt(i) {
    if (!isSelectable(items, i)) return;
    const v = items[i].value;
    if (multiple) {
      value = toggleMembership(value, v);
      onchange?.(value);
      /* Stay open: multi-select toggles accumulate. */
    } else {
      value = v;
      onchange?.(v);
      closeMenu();
    }
  }

  function moveActive(delta) {
    if (!items.length) return;
    let i = activeIndex < 0 ? 0 : wrap(activeIndex + delta, items.length);
    for (let n = 0; n < items.length; n++) {
      if (isSelectable(items, i)) {
        activeIndex = i;
        return;
      }
      i = wrap(i + delta, items.length);
    }
  }

  function handleKeydown(e) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        /* CONSUMED: an Escape that closed this menu has been handled, so it must
           not ALSO reach an outer handler. Without this it kept bubbling, and in
           an app that binds Escape globally (PowerRP binds it to Deselect) one
           Escape both closed the menu and deselected the item whose property the
           menu was editing. The house precedent is explicit — NumericField and
           AngleField both stopPropagation on Escape "so it doesn't bubble into
           Deselect"; a popup owes the same courtesy. */
        e.stopPropagation();
        closeMenu();
        break;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        e.preventDefault();
        activeIndex = -1;
        moveActive(1);
        break;
      case "End":
        e.preventDefault();
        activeIndex = items.length;
        moveActive(-1);
        break;
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0) selectAt(activeIndex);
        break;
    }
  }

  function handleDocPointer(e) {
    if (!open) return;
    if (rootEl && !rootEl.contains(e.target)) closeMenu();
  }

  $effect(() => {
    if (!open) return;
    document.addEventListener("pointerdown", handleDocPointer, true);
    return () => document.removeEventListener("pointerdown", handleDocPointer, true);
  });

  /* LIVE PREVIEW of the active row (see the header). ONE effect covers hover AND
     keyboard because `activeIndex` is the single notion both drive — the
     pointerenter handler and moveActive() write the same state, so there is no
     second hover path that could drift from the arrow keys.

     `previewedIndex` is a PLAIN variable, deliberately not $state: it is what the
     effect has already reported, so making it reactive would re-run the effect on
     its own write. The early return makes the effect idempotent — a re-run for an
     unrelated reason (items changing identity, say) re-fires nothing. */
  let previewedIndex = -1;
  $effect(() => {
    const i = open && isSelectable(items, activeIndex) ? activeIndex : -1;
    if (i === previewedIndex) return;
    if (previewedIndex >= 0) oncancelpreview?.();
    if (i >= 0) onpreview?.(items[i].value);
    previewedIndex = i;
  });
</script>

<!-- Built-in glyph: inline <svg> on a 24×24 viewBox, colored by currentColor
     and sized by the caller's font-size (1em ⇒ the full 24-unit box). -->
{#snippet glyph(path)}
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d={path} />
  </svg>
{/snippet}

<div class="dd" bind:this={rootEl} onkeydown={handleKeydown}>
  <button
    type="button"
    class="dd-trigger"
    class:dd-open={open}
    aria-haspopup="listbox"
    aria-expanded={open}
    onclick={toggleMenu}
  >
    {#if trigger}
      {@render trigger(multiple ? summaryText : currentItem)}
    {:else}
      <span
        class="dd-trigger-label"
        class:dd-placeholder={multiple ? !value?.length : !currentItem}
      >
        {summaryText}
      </span>
      <!-- SVG caret, never a Unicode glyph (text carets size unpredictably —
           user rule). Inline <svg> for synchronous, churn-free render. Size via
           --dd-caret-size; flips on open. -->
      <span class="dd-caret" aria-hidden="true">
        {@render glyph(CARET_PATH)}
      </span>
    {/if}
  </button>

  {#if open}
    <div class="dd-menu" role="listbox" aria-multiselectable={multiple || undefined}>
      {#if header}
        <div class="dd-header">{@render header()}</div>
      {/if}

      <ul class="dd-list" bind:this={listEl}>
        {#each items as it, i}
          {#if isInsert(it)}
            <li class="dd-insert" role="presentation" aria-hidden="true">
              {#if insertSnippet}
                {@render insertSnippet(it.insert)}
              {:else if typeof it.insert === "function"}
                {@render it.insert()}
              {:else}
                {it.insert}
              {/if}
            </li>
          {:else}
            <li
              class="dd-item"
              class:dd-active={i === activeIndex}
              class:dd-selected={multiple ? isChecked(items, value, i) : it.value === value}
              class:dd-disabled={it.disabled}
              data-dd-index={i}
              role="option"
              aria-selected={multiple ? isChecked(items, value, i) : it.value === value}
              aria-disabled={it.disabled || undefined}
              onclick={() => selectAt(i)}
              onpointerenter={() => isSelectable(items, i) && (activeIndex = i)}
            >
              {#if multiple}
                <span class="dd-check" aria-hidden="true">
                  {#if isChecked(items, value, i)}
                    {@render glyph(CHECK_PATH)}
                  {/if}
                </span>
              {/if}
              <span class="dd-item-body">
                {#if itemSnippet}
                  {@render itemSnippet(it, i === activeIndex)}
                {:else}
                  {it.label}
                {/if}
              </span>
            </li>
          {/if}
        {/each}
      </ul>

      {#if footer}
        <div class="dd-footer">{@render footer()}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .dd {
    /* Default to the host's theme tokens so the control follows light/dark; the
       literals are the standalone fallback. */
    --dd-bg: var(--control-bg, rgba(20, 20, 30, 0.92));
    --dd-fg: var(--fg, #e0e0e0);
    --dd-fg-dim: var(--fg-dim, #888);
    --dd-border: var(--border, rgba(255, 255, 255, 0.18));
    --dd-radius: 6px;
    --dd-padding: 4px 10px;
    --dd-font-size: 0.85rem;
    --dd-hover-bg: var(--a-hover-bg, rgba(255, 255, 255, 0.08));
    --dd-active-bg: color-mix(in srgb, var(--accent, #7aa2f7) 25%, transparent);
    --dd-active-fg: var(--fg, #e0e0e0);
    --dd-menu-shadow: 0 4px 10px rgba(0, 0, 0, 0.45);
    --dd-menu-max-height: 240px;

    /* Trigger caret. Default size tracks the trigger's text height (1.2em of
       --dd-font-size) so it reads as matched to the label; overridable. */
    --dd-caret-size: 1.2em;
    --dd-caret-color: currentColor;
    --dd-caret-opacity: 0.7;

    /* Multi-select checkmark. */
    --dd-check-size: 1em;
    --dd-check-color: var(--dd-active-fg);

    /* Inserts: nearly invisible by default — content only, no decoration.
       Consumers opt into a look (e.g. dotted rules) via these props. */
    --dd-insert-padding: 0;
    --dd-insert-color: var(--dd-fg-dim);
    --dd-insert-border: none;

    position: relative;
    display: inline-block;
    font-size: var(--dd-font-size);
    color: var(--dd-fg);
  }

  .dd-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: var(--dd-bg);
    color: inherit;
    border: 1px solid var(--dd-border);
    border-radius: var(--dd-radius);
    padding: var(--dd-padding);
    font: inherit;
    cursor: pointer;
  }
  .dd-trigger:hover {
    background: var(--dd-hover-bg);
  }
  /* Open state: square the bottom corners and drop the bottom border so
     the trigger melds into the menu as one continuous shape. */
  .dd-trigger.dd-open {
    background: var(--dd-hover-bg);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }

  .dd-trigger-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dd-trigger-label.dd-placeholder {
    color: var(--dd-fg-dim);
  }
  /* Caret: inline <svg>, sized by --dd-caret-size and vertically centered.
     inline-flex collapses the line-box so the wrapper's height equals the
     glyph's — the caret is never taller than its glyph, so it can't stretch the
     trigger. font-size on the svg drives its 1em (width=height=1em) box. */
  .dd-caret {
    display: inline-flex;
    align-items: center;
    margin-left: auto;
    color: var(--dd-caret-color, currentColor);
    opacity: var(--dd-caret-opacity, 0.7);
  }
  .dd-caret svg {
    display: block;
    font-size: var(--dd-caret-size, 1.2em);
    transition: transform 120ms ease;
  }
  /* Open-state affordance: the down-caret flips to point up. */
  .dd-trigger.dd-open .dd-caret svg {
    transform: rotate(180deg);
  }

  /* Menu spans exactly the trigger's width via `right: 0`, so no width
     mismatch and no flare needed. */
  .dd-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 1000;
    background: var(--dd-bg);
    color: var(--dd-fg);
    border: 1px solid var(--dd-border);
    border-top: none;
    border-radius: 0 0 var(--dd-radius) var(--dd-radius);
    box-shadow: var(--dd-menu-shadow);
    overflow: hidden;
  }

  .dd-header {
    padding: 6px 8px;
    border-bottom: 1px solid var(--dd-border);
  }
  .dd-footer {
    padding: 6px 8px;
    border-top: 1px solid var(--dd-border);
  }

  .dd-list {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: var(--dd-menu-max-height);
    overflow-y: auto;
  }

  .dd-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: var(--dd-padding);
    cursor: pointer;
  }
  .dd-item-body {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dd-item.dd-active {
    background: var(--dd-hover-bg);
  }
  .dd-item.dd-selected {
    background: var(--dd-active-bg);
    color: var(--dd-active-fg);
  }
  .dd-item.dd-disabled {
    color: var(--dd-fg-dim);
    cursor: default;
  }

  /* Checkmark gutter: reserves its box even when empty so labels stay aligned. */
  .dd-check {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--dd-check-size);
    height: var(--dd-check-size);
    font-size: var(--dd-check-size);
    color: var(--dd-check-color);
  }
  .dd-check svg {
    display: block;
  }

  /* Insert row: content only by default. Decoration is opt-in via --dd-insert-*. */
  .dd-insert {
    padding: var(--dd-insert-padding);
    color: var(--dd-insert-color);
    border-top: var(--dd-insert-border);
    pointer-events: none;
    user-select: none;
  }
</style>
