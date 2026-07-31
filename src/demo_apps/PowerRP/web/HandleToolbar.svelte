<!--
  HandleToolbar — the floating canvas toolbar for the SELECTED HANDLES (the inner
  selection scope; see app.svelte.js handleSelection). It appears whenever one or
  more of the selected widget's modifier points are selected, and offers the
  operations that apply to the LIST ELEMENTS behind them.

  UNIVERSAL, NOT POLYGON-SPECIFIC. It knows nothing about vertices: a handle
  declares `element: {listKey, index}` (core/derive.nodeModifierPoints) and the
  actions route through core/lists.js, so every widget whose handles are list
  elements gets these tools with no code here. A handle that controls a plain scalar
  (a donut's inner radius) declares no element, and the list actions simply do not
  appear for it — the bar still reports the selection, because selecting and
  dragging handles is universal even where hide/purge is meaningless.

  WHY IT IS ONE BAR AND NOT A `floatingToolbar` PLUGIN DECLARATION: a plugin's
  floatingToolbar(state) is a PURE function of widget state, and these actions are a
  function of the SELECTION — which is app state the plugin cannot see. Making it a
  universal bar is also what keeps it from being re-declared per widget.

  ── HIDE AND PURGE ARE DELIBERATELY TWO DIFFERENT BUTTONS ────────────────────
  This mirrors the ITEM-level pair exactly one level down (Delete keyframes
  `active` off; Purge removes for good), and the distinction is load-bearing rather
  than cosmetic: HIDE writes only the visibility companion, so nothing is
  renumbered and every equation bound to a later element keeps its meaning; PURGE
  splices the element out, which shifts every later element's address by one. One
  button doing both would silently rewrite what a user's equations refer to, so the
  purge button's tooltip says so in words.

  Positioning, the above/below flip, the pointer-event discipline and the
  no-transform rule all come from FloatingCanvasPanel. Styling lives in app.css
  (.canvas-toolbar-row / .canvas-toolbar-count; the app convention: no <style>
  block, every colour/size from an --a-* token).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import FloatingCanvasPanel, { widgetPanelAnchor } from "./FloatingCanvasPanel.svelte";

  // app = the app store; handles = the SELECTED handles in world space (each
  // {id, x, y, element, active}); node = the render node OWNING those handles, which
  // is what the bar hangs off; worldToScreen = the PanZoom camera map.
  let { app, handles, node, worldToScreen } = $props();

  /** Icon size for the row's buttons — the .btn-icon glyph size the text format
   *  toolbar's own buttons use, so the two bars' rows are the same height. */
  const ICON = 18;

  // The bar hangs off THE WIDGET, exactly like the widget toolbar and every other
  // floating panel — `widgetPanelAnchor` is the shared helper for that one case, so
  // all three bars sit in the same place and flip above/below by the same rule.
  //
  // It used to hang off the SELECTED HANDLES' bounding box, which read as a tooltip
  // stuck to a handle and moved every time the selection changed — two different
  // conventions for the same kind of surface. User ruling: "it should be above the
  // widget or below like other toolbars", and separately "minor aesthetic
  // differences are fine if it means consolidating code". Anchoring to the widget
  // also means the bar does not jump while dragging a handle, and cannot cover the
  // very handles it acts on.
  //
  // `node` may be null for one frame while the selection settles (the handles derive
  // from app.selectedHandles(), the node from app.selectedNode(), and Svelte need
  // not update both in the same tick), so the panel is simply not rendered then
  // rather than being anchored at a guessed origin.
  let anchor = $derived(node ? widgetPanelAnchor(node, worldToScreen) : null);

  // Do the selected handles carry LIST ELEMENTS at all? Only then are hide/purge
  // meaningful (see the header). Every selected element visible → the toggle offers
  // Hide; otherwise it offers Show, which is the ITEM-level rule's own resolution
  // of the mixed-state problem: two explicit verbs, never a guessing toggle.
  let elements = $derived(handles.filter((h) => h.element));
  let allVisible = $derived(elements.length > 0 && elements.every((h) => h.active));

  // ── POINT TOGGLES (curve on/off, new-subpath) ────────────────────────────────
  // The widget DECLARES which on/off states its list-element handles carry
  // (registry `handleToggles`: {key, label, icon, isOn(element), set(element, on)});
  // this bar renders one toggle button per entry with NO knowledge of what a paint
  // path is. A paint path declares Curve and New-subpath; a widget that declares
  // none simply shows no toggles. Each element's RAW stored tuple is read off the
  // owning node's state by the handle's list key + index, so `isOn` can report the
  // group's state and a click flips it for ALL selected points at once.
  let toggles = $derived(node?.plugin.handleToggles ?? []);
  /** Query. The raw stored element tuples behind the selected list-element handles. */
  let rawElements = $derived(
    elements.map((h) => node?.state?.[h.element.list.key]?.[h.element.index]).filter((el) => el != null)
  );
  /** Pure function. Is a toggle ON for the whole selection (every element isOn)? */
  function toggleAllOn(t) {
    return rawElements.length > 0 && rawElements.every((el) => t.isOn(el));
  }
  /** Command. Flips a toggle for every selected point — ONE undo unit through the
   *  universal element-edit substrate, so it cannot drift from the point menu's. */
  function flipToggle(t) {
    const on = !toggleAllOn(t);
    app.transformHandleSelectionElements((el) => t.set(el, on));
  }
</script>

{#if handles.length && anchor}
  <FloatingCanvasPanel x={anchor.x} topY={anchor.topY} bottomY={anchor.bottomY} label="Selected points">
    {#snippet children()}
      <div class="canvas-toolbar-row">
        <span class="canvas-toolbar-count">{handles.length} selected</span>
        {#if elements.length}
          <!-- HIDE / SHOW: the eye toggle, the same mdi:eye ↔ mdi:eye-off pair (and
               the same one-undo-unit-per-flip contract) the Inspector's item-level
               visibility toggle uses. -->
          {#if allVisible}
            <Tooltip text="Hide — draws straight past it, keeping its number">
              <button class="btn-icon" aria-label="Hide selected points" onclick={() => app.setHandleSelectionActive(false)}>
                <iconify-icon icon="mdi:eye-off" width={ICON} height={ICON}></iconify-icon>
              </button>
            </Tooltip>
          {:else}
            <Tooltip text="Show">
              <button class="btn-icon" aria-label="Show selected points" onclick={() => app.setHandleSelectionActive(true)}>
                <iconify-icon icon="mdi:eye" width={ICON} height={ICON}></iconify-icon>
              </button>
            </Tooltip>
          {/if}
          <!-- PURGE: the destructive half, with the renumbering consequence stated
               in the tooltip rather than hidden (see the header). Same
               mdi:delete-forever-outline glyph as the item-level Purge command. -->
          <Tooltip text="Purge — removes it for good and renumbers the later points, shifting equations bound to them">
            <button class="btn-icon" aria-label="Purge selected points" onclick={() => app.purgeHandleSelection()}>
              <iconify-icon icon="mdi:delete-forever-outline" width={ICON} height={ICON}></iconify-icon>
            </button>
          </Tooltip>
          <!-- POINT TOGGLES (curve on/off, new-subpath): one pressed-state button per
               state the widget declares. `.btn-icon.active` is the app's existing
               pressed-toggle idiom (app.css: the selection accent, no fill), so no new
               styling is introduced here. -->
          {#each toggles as t (t.key)}
            <Tooltip text={t.help ?? t.label}>
              <button
                class="btn-icon"
                class:active={toggleAllOn(t)}
                aria-label={`${t.label} for selected points`}
                aria-pressed={toggleAllOn(t)}
                onclick={() => flipToggle(t)}
              >
                <iconify-icon icon={t.icon} width={ICON} height={ICON}></iconify-icon>
              </button>
            </Tooltip>
          {/each}
        {/if}
      </div>
    {/snippet}
  </FloatingCanvasPanel>
{/if}
