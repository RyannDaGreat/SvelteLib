<!--
  Dropdown [visual, general] — themable single-select.

  Drop-in replacement for native <select>: pass `items` and bind `value`.
  The menu is constrained to the trigger's width so the two pieces share
  the same silhouette and meld via squared seam corners — no SVG, no
  flare math. Items longer than the trigger truncate with ellipsis;
  size your trigger (e.g. `min-width` on the wrapper) to fit.

  Extensibility hooks:
    - `trigger` snippet — override the closed-state button rendering
    - `item`    snippet — override per-row rendering
    - `header`  snippet — content above the list (search box, etc.)
    - `footer`  snippet — content below the list (action buttons, etc.)

  Behavior: click trigger to open, click item to select, click outside or
  ESC to close. ↑/↓ to navigate, Enter to select, Home/End to jump.

  CSS custom properties:
    --dd-bg, --dd-fg, --dd-fg-dim, --dd-border, --dd-radius, --dd-padding,
    --dd-font-size, --dd-hover-bg, --dd-active-bg, --dd-active-fg,
    --dd-menu-shadow, --dd-menu-max-height
-->
<script>
  /**
   * Pure function. Index of the item whose value === `value`, or -1.
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
    /** @type {any} */
    value = $bindable(undefined),
    placeholder = "Select…",
    /** @type {(value:any)=>void} */
    onchange = undefined,

    trigger,
    item: itemSnippet,
    header,
    footer,
  } = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  let rootEl;

  const currentItem = $derived(items[findIndex(items, value)]);

  function openMenu() {
    open = true;
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
  .dd-caret {
    font-size: 0.7em;
    opacity: 0.7;
    margin-left: auto;
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
    padding: var(--dd-padding);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
