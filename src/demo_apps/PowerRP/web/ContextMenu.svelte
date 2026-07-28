<!--
  ContextMenu — a small pointer-positioned popup menu of ENTRIES, used first by the
  paint-path point menu (web/CanvasView.svelte openPointMenu, F.18). It is
  deliberately GENERIC: it knows nothing about paint paths or handles, only a list of
  {label, icon?, checked?, danger?, onselect} rows and where to appear. The widget
  DECLARES the operations (registry `handleToggles`) and the host assembles the
  entries, so any future canvas surface can reuse this same menu.

  WHY A SCOPED <style> HERE (against the app's usual "styling lives in app.css"
  convention): this is a brand-new component and app.css is owned by a sibling in the
  same fleet round, so centralizing its styles there would collide. The style is
  scoped, self-contained, and every colour comes from an --a-*/--fg token, so it
  tracks every theme for free; the few sizes are named local custom properties, per
  the CSS-variable rule.

  Props:
    x, y      — VIEWPORT-fixed screen coords the menu's top-left sits at (from the
                triggering event's clientX/clientY).
    entries   — [{label, icon?, checked?, danger?, onselect()}]. `checked` shows a
                tick (a toggle that is currently ON); `danger` tints the row.
    onclose   — called after a pick, on Escape, or on an outside click.
-->
<script>
  import "iconify-icon";

  let { x, y, entries = [], onclose } = $props();

  /** Icon glyph size — the panel-row icon size the rest of the app's menus use. */
  const ICON = 15;

  /** Command. Runs an entry then closes (a menu pick is one action + dismiss). */
  function pick(entry) {
    entry.onselect?.();
    onclose?.();
  }

  // DISMISSAL: an outside pointerdown or Escape closes the menu — the palette's own
  // dismissal discipline. Registered on window while mounted and torn down on
  // unmount, so no listener outlives the menu. The menu's own pointerdown
  // stops propagation (below), so a click INSIDE never reaches this.
  $effect(() => {
    const onDown = () => onclose?.();
    const onKey = (e) => { if (e.key === "Escape") onclose?.(); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="context-menu"
  role="menu"
  tabindex="-1"
  style={`left: ${x}px; top: ${y}px;`}
  onpointerdown={(e) => e.stopPropagation()}
>
  {#each entries as entry (entry.label)}
    <button
      type="button"
      role="menuitem"
      class="context-menu-item"
      class:danger={entry.danger}
      class:checked={entry.checked}
      onclick={() => pick(entry)}
    >
      <span class="context-menu-check">
        {#if entry.checked}<iconify-icon icon="mdi:check" width={ICON} height={ICON}></iconify-icon>{/if}
      </span>
      {#if entry.icon}<iconify-icon icon={entry.icon} width={ICON} height={ICON}></iconify-icon>{/if}
      <span class="context-menu-label">{entry.label}</span>
    </button>
  {/each}
</div>

<style>
  .context-menu {
    /* Named local sizes (the CSS-variable rule); every colour is a theme token. */
    --cm-pad: 4px;
    --cm-row-pad: 5px 10px;
    --cm-radius: 7px;
    --cm-min-w: 150px;
    --cm-gap: 8px;

    position: fixed;
    z-index: 60;
    min-width: var(--cm-min-w);
    padding: var(--cm-pad);
    background: var(--a-panel-bg);
    border: 1px solid color-mix(in srgb, var(--fg-dim) 45%, transparent);
    border-radius: var(--cm-radius);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
  }
  .context-menu-item {
    display: flex;
    align-items: center;
    gap: var(--cm-gap);
    width: 100%;
    padding: var(--cm-row-pad);
    border: 0;
    border-radius: calc(var(--cm-radius) - var(--cm-pad));
    background: transparent;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .context-menu-item:hover {
    background: color-mix(in srgb, var(--a-selection) 22%, transparent);
  }
  .context-menu-item.checked {
    color: var(--a-selection);
  }
  .context-menu-item.danger {
    color: var(--a-danger, #e05252);
  }
  .context-menu-check {
    display: inline-flex;
    width: var(--cm-gap);
    justify-content: center;
    color: var(--a-selection);
  }
  .context-menu-label {
    flex: 1;
  }
</style>
