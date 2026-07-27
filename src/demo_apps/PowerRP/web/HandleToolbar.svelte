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
  import FloatingCanvasPanel from "./FloatingCanvasPanel.svelte";

  // app = the app store; handles = the SELECTED handles in world space (each
  // {id, x, y, element, active}); worldToScreen = the PanZoom camera map.
  let { app, handles, worldToScreen } = $props();

  /** Icon size for the row's buttons — the .btn-icon glyph size the text format
   *  toolbar's own buttons use, so the two bars' rows are the same height. */
  const ICON = 18;

  // The bar hangs off the selected handles' bounding box in SCREEN space: centred
  // on it, above its top edge (flipping below near the viewport top). A BOX rather
  // than the centroid so a wide selection is not covered by its own toolbar, and
  // screen-space rather than local because the handles may be rotated — their
  // world positions are already the poses on screen (nodeModifierPoints wrapped
  // them through node.world), so no transform reasoning belongs here.
  let anchor = $derived.by(() => {
    const pts = handles.map((h) => worldToScreen(h.x, h.y));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return { x: (lo + hi) / 2, topY: Math.min(...ys), bottomY: Math.max(...ys) };
  });

  // Do the selected handles carry LIST ELEMENTS at all? Only then are hide/purge
  // meaningful (see the header). Every selected element visible → the toggle offers
  // Hide; otherwise it offers Show, which is the ITEM-level rule's own resolution
  // of the mixed-state problem: two explicit verbs, never a guessing toggle.
  let elements = $derived(handles.filter((h) => h.element));
  let allVisible = $derived(elements.length > 0 && elements.every((h) => h.active));
</script>

{#if handles.length}
  <FloatingCanvasPanel x={anchor.x} topY={anchor.topY} bottomY={anchor.bottomY} label="Selected points">
    {#snippet children()}
      <div class="canvas-toolbar-row">
        <span class="canvas-toolbar-count">{handles.length} selected</span>
        {#if elements.length}
          <!-- HIDE / SHOW: the eye toggle, the same mdi:eye ↔ mdi:eye-off pair (and
               the same one-undo-unit-per-flip contract) the Inspector's item-level
               visibility toggle uses. -->
          {#if allVisible}
            <Tooltip text="Hide (draws straight past it; keeps its place, so nothing is renumbered)">
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
          <Tooltip text="Purge (removes it for good and renumbers the later points, so equations referring to them shift)">
            <button class="btn-icon" aria-label="Purge selected points" onclick={() => app.purgeHandleSelection()}>
              <iconify-icon icon="mdi:delete-forever-outline" width={ICON} height={ICON}></iconify-icon>
            </button>
          </Tooltip>
        {/if}
      </div>
    {/snippet}
  </FloatingCanvasPanel>
{/if}
