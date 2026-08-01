<!--
  ContextMenu — a small pointer-positioned popup menu of ENTRIES, used first by the
  paint-path point menu (web/CanvasView.svelte openPointMenu, F.18). It is
  deliberately GENERIC: it knows nothing about paint paths or handles, only a list of
  {label, icon?, checked?, danger?, onselect} rows and where to appear. The widget
  DECLARES the operations (registry `handleToggles`) and the host assembles the
  entries, so any future canvas surface can reuse this same menu.

  WHY A SCOPED <style> IS STILL HERE (against the app's "styling lives in app.css"
  convention) — RE-DATED 2026-08-01, not deleted, because the original reason has
  outlived the round that produced it. Original reason (2026-07-28, fde04ee): the
  component was new and app.css was owned by a sibling agent, so centralizing would
  collide. Current reason: app.css again has another agent's uncommitted hunks, and a
  pathspec commit takes the WHOLE file — moving this block would sweep their in-flight
  work into our commit. So the block STAYS DEFERRED, with a new reason rather than
  silence. The relocation is a mechanical follow-up: every declaration below is already
  a shared token, so the move is a copy with the selectors reparented under `.main`.

  WHAT WAS WRONG UNTIL 2026-08-01, recorded because it is the failure mode this
  deferral causes: living outside app.css let this file invent FIVE private answers to
  questions app.css had already settled, and the worst of them was invisible.
    · `color: var(--a-danger, #e05252)` — --a-danger DOES NOT EXIST, so the danger row
      painted a hardcoded hex in ALL ~25 themes while app.css:422 states that --a-guide
      IS this system's danger colour (and .btn.danger uses it). A phantom token with a
      hex fallback is a SILENT FALLBACK in CSS form: no error, just the wrong colour.
    · `z-index: 60` — a popover inventing its own small number, the exact bug
      --a-z-popover (app.css:620) exists to make unrepresentable: "Anything that opens
      on top of the app reads this token; nothing invents its own."
    · `--cm-radius: 7px` — a FOURTH radius token past the 4px cap, which app.css:649
      warns about by name.
    · a hand-rolled box-shadow and border, where --a-glass-shadow and the
      hairline/--border pair are what every other floating surface uses.
  All five now read the shared tokens, so this menu tracks every theme like its
  siblings do.

  Props:
    x, y      — VIEWPORT-fixed screen coords the menu's top-left sits at (from the
                triggering event's clientX/clientY).
    entries   — [{label, icon?, checked?, danger?, onselect()}]. `checked` shows a
                tick (a toggle that is currently ON); `danger` tints the row.
    onclose   — called after a pick, on Escape, or on an outside click.
-->
<script>
  import "iconify-icon";
  import { popupPosition } from "./popoverPlacement.js";

  let { x, y, entries = [], onclose } = $props();

  /** Icon glyph size — the panel-row icon size the rest of the app's menus use. */
  const ICON = 15;

  /** @type {HTMLDivElement|undefined} The menu panel, focused on open. */
  let menuEl = $state(undefined);

  /** The VIEWPORT-CLAMPED position, once the menu has been measured. Null until
   *  then, and the raw pointer point is used meanwhile — which is what the menu
   *  did unconditionally before, and is correct for every click that is not near
   *  an edge. @type {{left:number, top:number}|null} */
  let pos = $state(null);

  // CLAMP TO THE VIEWPORT. Until 2026-08-01 this menu wrote the raw pointer
  // clientX/clientY straight into left/top, so a right-click near the right or
  // bottom edge put it PARTLY OFF-SCREEN — entries unreachable, and on the bottom
  // edge the whole menu could be. A pointer is the DEGENERATE anchor rect (zero
  // size, at the cursor), which is exactly what popupPosition already handles:
  // open down-right by default, flip up near the bottom, slide left near the
  // right edge. Measured rather than assumed because the menu's height is its
  // entry count and its width is its longest label — neither is known here.
  // The size can only be read AFTER layout, so this runs in an effect and the
  // first paint may use the raw point; Svelte flushes effects before the browser
  // paints, so in practice the clamped value is what lands on screen.
  $effect(() => {
    if (!menuEl) return;
    const r = menuEl.getBoundingClientRect();
    pos = popupPosition({ left: x, right: x, top: y, bottom: y },
      r.width, r.height, window.innerWidth, window.innerHeight);
  });
  // Move focus INTO the menu on open. Two jobs at once: standard menu a11y, AND the
  // signal App.svelte's focusContext reads to raise the `popoverOpen` axis — so the
  // registry announces this menu's Escape "Close" (item 61, the HintBar Completeness
  // Law). Without focus here the menu's data-hint-popover would sit on an element no
  // focus is inside, and the chip would never show. On close, focus falls to the body
  // and the axis clears; the menu closes on a pick/Escape/outside-click.
  $effect(() => { menuEl?.focus(); });

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
  bind:this={menuEl}
  class="context-menu"
  role="menu"
  tabindex="-1"
  data-hint-popover="menu"
  style={`left: ${pos ? pos.left : x}px; top: ${pos ? pos.top : y}px;`}
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
    /* The two sizes with no token in app.css stay named local customs, per the
       CSS-variable rule. Everything else reads the shared token it should have read
       from the start — see the header for what each one replaced. */
    --cm-row-pad: 5px 10px; /* no shared menu-row metric exists yet; see header */
    --cm-min-w: 150px; /* narrowest width that fits the longest shipped entry */

    position: fixed;
    z-index: var(--a-z-popover); /* THE popover tier — never a local number */
    min-width: var(--cm-min-w);
    padding: var(--a-sp-2);
    background: var(--a-glass-bg-panel); /* the popovers'/toolbars' surface */
    border: var(--a-hairline) solid var(--border);
    border-radius: var(--a-radius-floating); /* the one rounded family, at its cap */
    box-shadow: var(--a-glass-shadow);
    display: flex;
    flex-direction: column;
  }
  .context-menu-item {
    display: flex;
    align-items: center;
    gap: var(--a-sp-3);
    width: 100%;
    padding: var(--cm-row-pad);
    border: 0;
    border-radius: var(--a-radius-control); /* a menu ROW is app chrome — square */
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
    /* --a-guide IS this design system's danger colour (app.css:422), and it is what
       .btn.danger uses. Every theme tunes it; the phantom --a-danger this replaced
       could not be tuned by any of them. */
    color: var(--a-guide);
  }
  .context-menu-check {
    display: inline-flex;
    width: var(--a-sp-3); /* the row gap — the tick slot is one gap wide */
    justify-content: center;
    color: var(--a-selection);
  }
  .context-menu-label {
    flex: 1;
  }
</style>
