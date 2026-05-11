<!--
  Dropdown [visual, general] — themable single-select dropdown.

  Drop-in replacement for native <select>: pass `items` and bind `value`.
  Extensibility hooks:
    - `trigger` snippet — override the closed-state button rendering
    - `item`    snippet — override per-row rendering (icons, multi-line, etc.)
    - `header`  snippet — content above the list (search box, etc.)
    - `footer`  snippet — content below the list (action buttons, etc.)

  Behavior: click trigger to open, click item to select, click outside or
  ESC to close. ↑/↓ to navigate, Enter to select, Home/End to jump.

  Usage:
    <Dropdown items={[{value:1,label:"One"},{value:2,label:"Two"}]} bind:value />

  CSS custom properties (set on Dropdown or any ancestor):
    --dd-bg              Trigger and menu background
    --dd-fg              Text color
    --dd-fg-dim          Dim text (e.g. placeholder)
    --dd-border          Border color
    --dd-radius          Corner radius
    --dd-padding         Trigger inner padding
    --dd-font-size       Text size
    --dd-hover-bg        Item hover background
    --dd-active-bg       Selected item background
    --dd-active-fg       Selected item text color
    --dd-menu-shadow     Menu drop shadow
    --dd-menu-max-height Max scrollable height of menu
    --dd-menu-gap        Vertical gap between trigger and menu (default 0)
-->
<script>
  /**
   * Pure function. Index of the item whose value === `value`, or -1.
   *
   * @param {{value:any}[]} items
   * @param {any} value
   * @returns {number}
   *
   * @example findIndex([{value:"a"},{value:"b"}], "b") // 1
   * @example findIndex([{value:"a"}], "x") // -1
   */
  function findIndex(items, value) {
    for (let i = 0; i < items.length; i++) if (items[i].value === value) return i;
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

  let {
    /** @type {{value:any,label:string,disabled?:boolean}[]} */
    items = [],
    /** @type {any} Selected value (bindable, like native <select>) */
    value = $bindable(undefined),
    /** @type {string} Shown when no item matches `value` */
    placeholder = "Select…",
    /** @type {(value:any)=>void} Called after selection */
    onchange = undefined,

    /** Snippet(currentItem | undefined): override the trigger inner content */
    trigger,
    /** Snippet(item, isActive): override per-row rendering */
    item: itemSnippet,
    /** Snippet(): content above the item list */
    header,
    /** Snippet(): content below the item list */
    footer,
  } = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  let rootEl;

  const currentItem = $derived(items[findIndex(items, value)]);

  function openMenu() {
    open = true;
    /* When opening, focus the currently selected row (or first) for keyboard nav */
    activeIndex = Math.max(0, findIndex(items, value));
  }

  function closeMenu() {
    open = false;
    activeIndex = -1;
  }

  function toggleMenu() {
    open ? closeMenu() : openMenu();
  }

  function selectAt(i) {
    const it = items[i];
    if (!it || it.disabled) return;
    value = it.value;
    onchange?.(it.value);
    closeMenu();
  }

  function moveActive(delta) {
    if (!items.length) return;
    let i = activeIndex < 0 ? 0 : wrap(activeIndex + delta, items.length);
    /* Skip disabled rows; bail after a full lap to avoid infinite loop */
    for (let n = 0; n < items.length; n++) {
      if (!items[i].disabled) {
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
        activeIndex = 0;
        moveActive(0);
        break;
      case "End":
        e.preventDefault();
        activeIndex = items.length - 1;
        moveActive(0);
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
</script>

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
      {@render trigger(currentItem)}
    {:else}
      <span class="dd-trigger-label" class:dd-placeholder={!currentItem}>
        {currentItem?.label ?? placeholder}
      </span>
      <span class="dd-caret" aria-hidden="true">▾</span>
    {/if}
  </button>

  {#if open}
    <div class="dd-menu" role="listbox">
      {#if header}
        <div class="dd-header">{@render header()}</div>
      {/if}

      <ul class="dd-list">
        {#each items as it, i}
          <li
            class="dd-item"
            class:dd-active={i === activeIndex}
            class:dd-selected={it.value === value}
            class:dd-disabled={it.disabled}
            role="option"
            aria-selected={it.value === value}
            aria-disabled={it.disabled || undefined}
            onclick={() => selectAt(i)}
            onpointerenter={() => !it.disabled && (activeIndex = i)}
          >
            {#if itemSnippet}
              {@render itemSnippet(it, i === activeIndex)}
            {:else}
              {it.label}
            {/if}
          </li>
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
    /* -- Themeable custom properties -- */
    --dd-bg: rgba(0, 0, 0, 0.5);
    --dd-fg: #e0e0e0;
    --dd-fg-dim: #888;
    --dd-border: rgba(255, 255, 255, 0.15);
    --dd-radius: 6px;
    --dd-padding: 4px 8px;
    --dd-font-size: 0.85rem;
    --dd-hover-bg: rgba(255, 255, 255, 0.08);
    --dd-active-bg: rgba(122, 162, 247, 0.2);
    --dd-active-fg: #e0e0e0;
    --dd-menu-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    --dd-menu-max-height: 240px;
    --dd-menu-gap: 0px;

    position: relative;
    display: inline-block;
    font-size: var(--dd-font-size);
    color: var(--dd-fg);
  }

  .dd-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--dd-bg);
    color: inherit;
    border: 1px solid var(--dd-border);
    border-radius: var(--dd-radius);
    padding: var(--dd-padding);
    font: inherit;
    cursor: pointer;
  }
  .dd-trigger:hover,
  .dd-trigger.dd-open {
    background: var(--dd-hover-bg);
  }
  /* While open, square off the bottom corners and drop the bottom border
     so the trigger melds into the menu as one continuous shape. */
  .dd-trigger.dd-open {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }

  .dd-trigger-label.dd-placeholder {
    color: var(--dd-fg-dim);
  }

  .dd-caret {
    font-size: 0.7em;
    opacity: 0.7;
  }

  .dd-menu {
    position: absolute;
    top: calc(100% + var(--dd-menu-gap));
    left: 0;
    min-width: 100%;
    z-index: 1000;
    background: var(--dd-bg);
    color: var(--dd-fg);
    border: 1px solid var(--dd-border);
    border-radius: 0 0 var(--dd-radius) var(--dd-radius);
    box-shadow: var(--dd-menu-shadow);
    overflow: hidden;
    backdrop-filter: blur(8px);
  }

  .dd-header,
  .dd-footer {
    padding: 6px 8px;
    border-color: var(--dd-border);
  }
  .dd-header {
    border-bottom: 1px solid var(--dd-border);
  }
  .dd-footer {
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
    padding: var(--dd-padding);
    cursor: pointer;
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
</style>
