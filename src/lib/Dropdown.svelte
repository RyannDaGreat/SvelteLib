<!--
  Dropdown [visual, general] — themable single- or multi-select.

  Drop-in replacement for native <select>: pass `items` and bind `value`.
  The menu is constrained to the trigger's width so the two pieces share
  the same silhouette and meld via squared seam corners — no SVG, no
  flare math. Items longer than the trigger truncate with ellipsis;
  size your trigger (e.g. `min-width` on the wrapper) to fit.

  CONTAINMENT — GIVE `.dd` A DEFINITE WIDTH. This component's root is a
  shrink-to-fit inline-block, and inside a flex or grid cell its shrink-to-fit
  width is resolved from the row's FULL width while that cell's own content-based
  basis is being measured — i.e. before the cell shrinks. So a long label makes
  the trigger WIDER THAN ITS CELL, and because the menu spans the trigger
  (left:0/right:0) the open menu overflows with it and paints over whatever sits
  to the right. Measured in PowerRP: a 447.6px trigger in a 294px cell, menu
  crossing into the next pane and over a <video>. `width: 100%` on `.dd` (which
  is what `.inspector .row .dd` does, and now `.render-center-control .dd`) fixes
  it outright — the trigger is then sized from the settled cell and the ellipsis
  above has something to bite on. Give the wrapper a `min-width` instead when you
  would rather the control stay legible than stay inside.

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
    - `open`      ($bindable) — the menu's open state, exposed so a wrapper
                  (SearchableDropdown) can react to open/close (focus its search
                  box, clear its query). Existing callers leave it unbound.
    - `listItems` — the rows the menu RENDERS and navigates, when they differ
                  from `items`. `items` still resolves the TRIGGER label and the
                  selected value; `listItems` (a filtered/ranked subset) drives
                  the list, arrow keys, hover-preview and selection. This is the
                  seam SearchableDropdown uses to filter without the trigger
                  going blank when the selected row is filtered out. Unset ⇒
                  identical to before (list === items).

  FLOATING MENU (no-clip): the open menu is `position: fixed`, positioned at the
  trigger's viewport rect, so it ESCAPES an ancestor's `overflow:hidden` (the
  Inspector pane clipped it at the pane bottom — the reported bug) rather than
  being trapped in the panel's flow. It flips ABOVE the trigger when there is no
  room below, caps its height to the available space, and on an OUTSIDE scroll
  FOLLOWS the anchor (repositioning) rather than closing — see handleWindowScroll
  for why blind close-on-scroll was wrong here. It stays a DOM descendant of the
  root (not portaled), so keyboard
  bubbling, outside-click containment, and consumers that query `.dd-item` inside
  the row all keep working. Requires no transformed ancestor between the trigger
  and the viewport (same constraint Tooltip already relies on here).

  SCROLL-UPDATES-HOVER: scrolling the option list under a stationary pointer
  re-hit-tests the row now under the cursor and makes IT the active/previewed
  row — a scroll fires no mousemove, so without this the preview would lag the
  visible list.

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

  /* Floating-menu placement (positionMenu). DEFAULT_MENU_MAX_H mirrors the CSS
     `--dd-menu-max-height` default so the list still caps + scrolls at the usual
     height; the fixed-position box only shrinks BELOW it when the viewport is
     tight. VIEWPORT_MARGIN is the sliver kept between the menu and the edge. */
  const DEFAULT_MENU_MAX_H = 240;
  const VIEWPORT_MARGIN = 6;

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
    /** @type {boolean} $bindable menu open state — a wrapper may observe it */
    open = $bindable(false),
    /** @type {any[]|undefined} rows to RENDER/navigate (filtered subset); `items`
     *  still resolves the trigger label + value. Unset ⇒ list === items. */
    listItems = undefined,

    trigger,
    item: itemSnippet,
    insert: insertSnippet,
    header,
    footer,
  } = $props();

  let activeIndex = $state(-1);
  let rootEl;
  let triggerEl = $state(null);
  let listEl = $state(null);
  let menuEl = $state(null);

  /* The rows the MENU shows and the keyboard/hover navigate. `items` stays the
     source for the trigger label + value resolution; a wrapper passing a
     filtered `listItems` gets a filtered list without the trigger going blank. */
  const rows = $derived(listItems ?? items);

  /* Fixed-position box for the open menu (viewport coords), recomputed on open,
     scroll, and resize. null before the first measure. */
  let menuPos = $state(null);
  /* Last known pointer position (viewport), so a scroll under a stationary mouse
     can re-hit-test what is now under the cursor. */
  let lastPointer = null;

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
    const idx = findIndex(rows, multiple ? undefined : value);
    if (idx >= 0) return idx;
    for (let i = 0; i < rows.length; i++) if (isSelectable(rows, i)) return i;
    return -1;
  }

  function openMenu() {
    open = true;
    activeIndex = firstSelectableFor(value);
    if (scrollToValue !== undefined) scrollTargetIntoView(scrollToValue);
    /* Seed a valid down-placement from the trigger rect (which exists now) so the
       FIRST render is already correctly positioned — no null frame that would
       fall back to the CSS anchor. rAF then refines it once the list has laid out
       (measuring its height decides the flip). */
    if (triggerEl) {
      const r = triggerEl.getBoundingClientRect();
      menuPos = { left: r.left, top: r.bottom, width: r.width, maxHeight: DEFAULT_MENU_MAX_H, placement: "down" };
    }
    requestAnimationFrame(positionMenu);
  }

  function closeMenu() {
    open = false;
    activeIndex = -1;
    menuPos = null;
  }

  function toggleMenu() {
    open ? closeMenu() : openMenu();
  }

  /* Command: scroll the row whose value === target into view, centered.
     Waits a frame so the menu has laid out before measuring. */
  function scrollTargetIntoView(target) {
    const idx = findIndex(rows, target);
    if (idx < 0) return;
    requestAnimationFrame(() => {
      const row = listEl?.querySelector(`[data-dd-index="${idx}"]`);
      row?.scrollIntoView({ block: "center" });
    });
  }

  function selectAt(i) {
    if (!isSelectable(rows, i)) return;
    const v = rows[i].value;
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
    if (!rows.length) return;
    let i = activeIndex < 0 ? 0 : wrap(activeIndex + delta, rows.length);
    for (let n = 0; n < rows.length; n++) {
      if (isSelectable(rows, i)) {
        activeIndex = i;
        return;
      }
      i = wrap(i + delta, rows.length);
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
        activeIndex = rows.length;
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

  /* Command. Positions the open menu as a FIXED box at the trigger's viewport
     rect, flipping ABOVE when there is no room below and capping its height to
     the space available on the chosen side. Fixed positioning is what lets the
     menu escape an ancestor's overflow:hidden (the clipped-at-pane-bottom bug)
     without portaling it out of the root. Reads DOM geometry, writes menuPos. */
  function positionMenu() {
    if (!open || !triggerEl) return;
    const r = triggerEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    /* The menu's NATURAL desired height, measured from the LIST's full content
       (scrollHeight ignores the max-height cap, unlike menuEl's height, so this
       does NOT feed back on a previously-capped measurement) plus the header. */
    const headerH = menuEl?.querySelector(".dd-header")?.offsetHeight ?? 0;
    const natural = (listEl ? listEl.scrollHeight : 0) + headerH;
    /* Flip up only when below is too short for the natural menu AND above has more
       room. Prefer below (the legacy anchored look). */
    const flipUp = spaceBelow < natural && spaceAbove > spaceBelow;
    /* Cap the list to the room on the chosen side, but never TALLER than the
       component's own --dd-menu-max-height default — so a long list still scrolls
       instead of ballooning to fill the pane. VIEWPORT_MARGIN keeps a hair of gap
       to the edge so the not-clipped invariant holds. */
    const room = (flipUp ? spaceAbove : spaceBelow) - VIEWPORT_MARGIN - headerH;
    const maxHeight = Math.max(0, Math.min(DEFAULT_MENU_MAX_H, room));
    menuPos = flipUp
      ? { left: r.left, bottom: vh - r.top, width: r.width, maxHeight, placement: "up" }
      : { left: r.left, top: r.bottom, width: r.width, maxHeight, placement: "down" };
  }

  /* Command. Responds to an OUTSIDE scroll that moves the anchor by REPOSITIONING
     the fixed menu to follow the trigger — it stays glued to the anchor through
     any scroll. The menu list's OWN scroll instead re-hovers (onListScroll);
     scroll events don't bubble, so this capture-phase listener sees every scroll
     and discriminates by target.

     Why follow rather than CLOSE-on-scroll (the textbook behavior): opening the
     fixed menu itself perturbs the ancestor panel's scroll (measured: the
     Inspector panel-body bounced 584→714→584 px as the menu mounted, briefly
     scrolling the trigger's rect off-screen). A close on that SPURIOUS scroll
     tore the menu down mid-hover and wiped the live material preview — and it is
     not distinguishable from a genuine scroll at the event. Following the anchor
     (the Floating-UI/Radix default) survives the spurious scroll and keeps the
     menu correct through a genuine one; an outside pointerdown / Escape / pick
     still closes it. */
  function handleWindowScroll(e) {
    if (!open) return;
    if (e.target === listEl || (menuEl && menuEl.contains(e.target))) {
      onListScroll();
      return;
    }
    const scroller = e.target === document ? document.documentElement : e.target;
    if (scroller?.contains?.(triggerEl)) positionMenu();
  }

  /* Command. Re-hit-test what the (stationary) pointer is now over after the list
     scrolled, and make THAT row active — a scroll fires no mousemove, so the
     previewed row must be recomputed from the pointer position by hand. */
  function onListScroll() {
    if (!open || !lastPointer || !listEl) return;
    const el = document.elementFromPoint(lastPointer.x, lastPointer.y);
    const row = el && el.closest?.("[data-dd-index]");
    if (!row || !listEl.contains(row)) return;
    const i = Number(row.getAttribute("data-dd-index"));
    if (Number.isInteger(i) && isSelectable(rows, i)) activeIndex = i;
  }

  function trackPointer(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
  }

  /* One effect owns every while-open document/window listener + the initial
     placement. It reads `open` only; the listeners it installs write menuPos /
     activeIndex / lastPointer, none of which it reads — so it never re-runs
     itself (the FontPicker effect-depth precedent). */
  $effect(() => {
    if (!open) return;
    document.addEventListener("pointerdown", handleDocPointer, true);
    window.addEventListener("scroll", handleWindowScroll, true);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("pointermove", trackPointer, true);
    positionMenu();
    return () => {
      document.removeEventListener("pointerdown", handleDocPointer, true);
      window.removeEventListener("scroll", handleWindowScroll, true);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("pointermove", trackPointer, true);
    };
  });

  /* LIVE PREVIEW of the active row (see the header). ONE effect covers hover AND
     keyboard because `activeIndex` is the single notion both drive — the
     pointerenter handler and moveActive() write the same state, so there is no
     second hover path that could drift from the arrow keys.

     `previewed*` are PLAIN variables, deliberately not $state: they are what the
     effect has already reported, so making them reactive would re-run the effect
     on its own write. The early return makes it idempotent.

     It keys on the previewed VALUE, not just the index: under a live filter the
     active index can stay 0 while the row AT 0 changes (glass → crt as you type),
     and an index-only guard would wrongly suppress the new preview. */
  let previewedIndex = -1;
  let previewedValue;
  $effect(() => {
    const i = open && isSelectable(rows, activeIndex) ? activeIndex : -1;
    const v = i >= 0 ? rows[i].value : undefined;
    if (i === previewedIndex && v === previewedValue) return;
    if (previewedIndex >= 0) oncancelpreview?.();
    if (i >= 0) onpreview?.(v);
    previewedIndex = i;
    previewedValue = v;
  });

  /* Keep the active row valid as `listItems` narrows under a live filter: when
     the current index falls off the end (or onto an insert/disabled row) of the
     new list, re-point to its first selectable row. Reads+writes activeIndex but
     CONVERGES — the value it writes is always in range, so the guard is false on
     the re-run (the FontPicker keep-in-range precedent). Inert for callers that
     never pass listItems (rows === items, which doesn't churn while open). */
  $effect(() => {
    if (!open) return;
    if (activeIndex < rows.length && (activeIndex < 0 || isSelectable(rows, activeIndex))) return;
    let i = -1;
    for (let k = 0; k < rows.length; k++) if (isSelectable(rows, k)) { i = k; break; }
    activeIndex = i;
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
    bind:this={triggerEl}
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
    <!-- FIXED at the trigger's viewport rect (see the FLOATING MENU note) so an
         ancestor's overflow can't clip it; menuPos is null for the first frame
         (pre-measure), when we fall back to the anchored-below look. -->
    <div
      class="dd-menu"
      class:dd-menu-up={menuPos?.placement === "up"}
      role="listbox"
      aria-multiselectable={multiple || undefined}
      bind:this={menuEl}
      style:position="fixed"
      style:left={menuPos ? `${menuPos.left}px` : null}
      style:right="auto"
      style:top={menuPos?.placement === "up" ? "auto" : (menuPos ? `${menuPos.top}px` : null)}
      style:bottom={menuPos?.placement === "up" ? `${menuPos.bottom}px` : "auto"}
      style:width={menuPos ? `${menuPos.width}px` : null}
      style:--dd-menu-max-height={menuPos ? `${menuPos.maxHeight}px` : null}
    >
      {#if header}
        <div class="dd-header">{@render header()}</div>
      {/if}

      <ul class="dd-list" bind:this={listEl} onscroll={onListScroll}>
        {#each rows as it, i}
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
              class:dd-selected={multiple ? isChecked(rows, value, i) : it.value === value}
              class:dd-disabled={it.disabled}
              data-dd-index={i}
              role="option"
              aria-selected={multiple ? isChecked(rows, value, i) : it.value === value}
              aria-disabled={it.disabled || undefined}
              onclick={() => selectAt(i)}
              onpointerenter={() => isSelectable(rows, i) && (activeIndex = i)}
            >
              {#if multiple}
                <span class="dd-check" aria-hidden="true">
                  {#if isChecked(rows, value, i)}
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
    /* Stacking level of the open (fixed) menu. Chains to PowerRP's popover
       z token when present; the literal is the standalone fallback. */
    --dd-menu-z: var(--a-z-popover, 1000);

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

  /* `overflow: hidden` is doing two jobs: it enables the ellipsis, AND it is what
     lets this flex item shrink at all — a flex item whose overflow is not
     `visible` has an automatic minimum size of zero, so no `min-width: 0` is
     needed here (measured: adding one changes nothing). The ellipsis therefore
     applies exactly when the TRIGGER has a definite width — see the docblock's
     CONTAINMENT note for what the consumer must supply. */
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

  /* Menu is a FIXED box placed at the trigger's viewport rect by positionMenu
     (inline left/top-or-bottom/width), so it escapes an ancestor's overflow.
     The inline `position:fixed` + coords win over these; `top:100%;left:0` here
     is only the pre-measure fallback for the first frame before menuPos exists,
     matching the legacy anchored-below look. z-index via --dd-menu-z (an ambient
     --a-z token in PowerRP; a literal fallback for standalone use). */
  .dd-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: var(--dd-menu-z, 1000);
    background: var(--dd-bg);
    color: var(--dd-fg);
    border: 1px solid var(--dd-border);
    border-top: none;
    border-radius: 0 0 var(--dd-radius) var(--dd-radius);
    box-shadow: var(--dd-menu-shadow);
    overflow: hidden;
  }
  /* Flipped ABOVE the trigger: the seam is now on the menu's BOTTOM edge, so
     square the bottom corners / round the top and drop the bottom border join. */
  .dd-menu.dd-menu-up {
    border-top: 1px solid var(--dd-border);
    border-bottom: none;
    border-radius: var(--dd-radius) var(--dd-radius) 0 0;
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
