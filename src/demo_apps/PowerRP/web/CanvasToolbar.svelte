<!--
  CanvasToolbar — THE SPEC RENDERER for a widget's floating canvas bar. Opened by
  DOUBLE-CLICKING a widget whose plugin declares `floatingToolbar(state)`, and
  mounted inside web/FloatingCanvasPanel.svelte, which owns every positioning
  decision (anchor, the flip near the top edge, the pointer-events discipline, the
  no-transform rule). This file owns only WHAT IS IN the panel.

  DECLARATIVE, GENERAL MECHANISM: a plugin returns a toolbar SPEC — analogous to
  how it declares inspector rows — and this component renders it. There are two
  content kinds, and a spec may carry either:

    { grid: { property, value, cells: [{value, label, svg}] } }
        A visual PICKER. Each cell is its own SVG thumbnail; clicking one writes
        `property = cell.value`. The cursor widget picks a cursor this way instead
        of through an Inspector dropdown.

    { fields: [{ id, label, value, keys, size, help }] }
        An editable READOUT. Each field is a text input showing `value`; committing
        one asks the plugin `fieldWrites(state, id, text)` for the state writes it
        means. The plugin owns BOTH directions, which is what lets one field stand
        for several stored leaves — the Mandelbrot's Re/Im each show the exact
        decimal sum of a coarse+fine SPLIT coordinate and take a 30-digit paste
        back apart losslessly, which a raw per-leaf row cannot do.

  A field is DISABLED when any of the stored leaves it names in `keys` holds an `=`
  equation. That is the ruling interior explore already makes for the same
  situation (interiorNav's equationBoundInteriorProps): committing would overwrite
  the equation with the number it currently evaluates to, so the bar refuses and
  says where to edit it instead. Silently clobbering a binding is not an option.

  HOVERING a grid cell LIVE-PREVIEWS it on the widget: preview() stages the same
  property write into app.previewDelta (the viewport re-renders it; the document is
  untouched and no undo entry is created), each pointerenter overwrites the last,
  and leaving the GRID reverts via app.cancelPreview(). This is the ToolsPane preset
  card-grid contract applied to a cell grid — the house rule that a palette
  selection previews under the pointer before you commit to it. FIELDS do not
  preview: there is no hover to preview from, and a half-typed coordinate is not a
  value anyone wants to see rendered.

  Styling lives in app.css (.canvas-toolbar-*; the app convention: NO <style>
  block, every color/size from an --a-* token).
-->
<script>
  import Tooltip from "../../../lib/Tooltip.svelte";
  import FloatingCanvasPanel, { widgetPanelAnchor } from "./FloatingCanvasPanel.svelte";
  import { isEquationValue } from "../core/expressions.js";

  // app = the app store; node = the widget's derived render node; worldToScreen =
  // the PanZoom camera map (render-area frame); zoom = viewport.zoom (kept for
  // parity with the sibling controllers / future zoom-aware sizing).
  let { app, node, worldToScreen, zoom } = $props();

  // The plugin's declarative toolbar spec for this widget's current state.
  let spec = $derived(node.plugin.floatingToolbar?.(node.state) ?? null);

  // The panel anchor: the widget's top/bottom centre in render-area screen px.
  // FloatingCanvasPanel decides which edge to hang from.
  let anchor = $derived(widgetPanelAnchor(node, worldToScreen));

  // Whether OUR hover currently owns app.previewDelta. A PLAIN (non-$state)
  // bridge variable — written and read imperatively, it must never drive a
  // re-render — following CommandPalette's previewRevert/previewedId.
  let previewing = false;

  /** Command. Live-previews `value` on the widget's grid property WITHOUT
   * committing: stages it into app.previewDelta so the viewport (and this
   * grid's own selected ring, which reads the derived state) shows the hovered
   * cell, while the document stays untouched and no undo entry is created. The
   * next hover overwrites it; leaving the grid reverts it. */
  function preview(property, value) {
    previewing = true;
    app.setPreview([[["items", node.itemId, property], value]]);
  }

  /** Command. Reverts the hover preview. Guarded on `previewing` so a revert
   * that lands after a commit — or while another surface owns previewDelta —
   * never discards someone else's staged change. */
  function revert() {
    if (!previewing) return;
    previewing = false;
    app.cancelPreview();
  }

  /** Command. Writes the picked value onto the widget's grid property as ONE
   * undo unit (the standard preview→commit seam the Inspector uses). Re-staging
   * the value keeps a pointer-less activation (Enter on a focused tile, which
   * fires no pointerenter) on the same path; commitPreview consumes the stage,
   * so the hover no longer owns it. */
  function pick(property, value) {
    app.setPreview([[["items", node.itemId, property], value]]);
    app.commitPreview();
    previewing = false;
  }

  /** Query. The stored leaves of `field` that hold an `=` equation, as keys.
   * Empty when the field is free to edit. The stored value is read (never the
   * derived one) because that is where an equation still IS an equation. */
  function boundKeys(field) {
    return (field.keys ?? []).filter((key) => isEquationValue(node.plugin, [key], app.storedItemValue(node.itemId, [key])));
  }

  /** Command. Commits a field's typed text as ONE undo unit, through the plugin's
   * own `fieldWrites`. Text the plugin does not accept commits NOTHING and the
   * input is restored from the spec, so a typo cannot half-write a coordinate.
   *
   * GUARDED ON AN OPEN DRAFT, and that guard is load-bearing: Enter commits and then
   * BLURS the input, and blur is itself a commit path (clicking away must not discard
   * what was typed). Measured without the guard, one Enter produced TWO identical
   * commits — two undo entries for one edit, so the first undo appeared to do nothing.
   * Clearing the draft first makes the second call a no-op, which is also what makes
   * opening a field and leaving it untouched commit nothing at all. */
  function commitField(field, text) {
    if (draft[field.id] === undefined) return;
    draft = { ...draft, [field.id]: undefined }; // fall back to the spec's value
    const writes = node.plugin.fieldWrites?.(node.state, field.id, text);
    if (!writes) return;
    app.setPreview(Object.entries(writes).map(([key, value]) => [["items", node.itemId, key], value]));
    app.commitPreview();
  }

  // Per-field IN-PROGRESS text, by field id. A field shows its draft while being
  // typed in and the SPEC's value otherwise — so a gesture that moves the view
  // updates every field the moment it happens, and typing is never overwritten
  // mid-keystroke by the value the field is about to replace.
  let draft = $state({});

  /** Pure function. What a field's input shows: the live draft if one is open,
   * else the spec's own value.
   * @example // shown({id: "zoom", value: "6"}) with no draft → "6" */
  function shown(field) {
    return draft[field.id] ?? field.value;
  }

  /** Command. Keydown in a field: Enter commits, Escape abandons the draft. Both
   * stopPropagation so the canvas's own Escape (which would exit explore mode)
   * does not fire while a field is being edited — the in-place text editor's
   * ruling, applied here. */
  function onFieldKey(e, field) {
    if (e.key === "Enter") {
      e.stopPropagation();
      commitField(field, e.currentTarget.value);
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      draft = { ...draft, [field.id]: undefined };
      e.currentTarget.blur();
    }
  }

  // The toolbar can UNMOUNT with the pointer still over a tile (Escape, a
  // deselect, or a purge closes it), which fires no pointerleave — so the
  // revert must not depend on one (the GradientPresetPicker close() rule).
  // Without this a staged hover would outlive the grid and be baked into the
  // document by the NEXT commitPreview from anywhere in the app.
  $effect(() => {
    return () => revert();
  });
</script>

{#if spec?.grid || spec?.fields}
  <FloatingCanvasPanel x={anchor.x} topY={anchor.topY} bottomY={anchor.bottomY} label={spec.label ?? "Widget toolbar"}>
    {#snippet children()}
      {#if spec.grid}
        <!-- pointerleave on the GRID (not each tile) reverts only when the
             pointer leaves the tiles entirely; moving BETWEEN tiles fires each
             one's pointerenter, overwriting the preview without a revert in
             between (the ToolsPane preset card-grid precedent). -->
        <div class="canvas-toolbar-grid" role="listbox" aria-label="Cursor" tabindex="-1" onpointerleave={revert}>
          {#each spec.grid.cells as cell (cell.value)}
            <!-- Cell name on hover via SvelteLib's immediate Tooltip (native
                 title= is banned in app chrome — manifest). Its anchor is
                 display:contents, so the button stays the grid item AND the
                 listbox's own option child. NOTE: the tip is position:fixed, so
                 the panel must not carry a transform — see FloatingCanvasPanel. -->
            <Tooltip text={cell.label}>
              <button
                type="button"
                class="canvas-toolbar-tile"
                class:selected={cell.value === spec.grid.value}
                role="option"
                aria-selected={cell.value === spec.grid.value}
                onpointerenter={() => preview(spec.grid.property, cell.value)}
                onclick={() => pick(spec.grid.property, cell.value)}
              >
                <img class="canvas-toolbar-thumb" src={dataUri(cell.svg)} alt={cell.label} draggable="false" />
              </button>
            </Tooltip>
          {/each}
        </div>
      {/if}
      {#if spec.fields}
        <div class="canvas-toolbar-fields">
          {#each spec.fields as field (field.id)}
            {@const bound = boundKeys(field)}
            <Tooltip text={bound.length ? `${field.label}: ${bound.join(", ")} ${bound.length === 1 ? "is an" : "are"} = equation — edit it in the Inspector. Typing here would overwrite the equation with its current value.` : field.help}>
              <label class="canvas-toolbar-field" class:narrow={field.size === "narrow"}>
                <span class="canvas-toolbar-field-label">{field.label}</span>
                <input
                  type="text"
                  class="canvas-toolbar-field-input"
                  data-hint-scope="commit"
                  spellcheck="false"
                  disabled={bound.length > 0}
                  value={shown(field)}
                  oninput={(e) => (draft = { ...draft, [field.id]: e.currentTarget.value })}
                  onkeydown={(e) => onFieldKey(e, field)}
                  onblur={(e) => commitField(field, e.currentTarget.value)}
                />
              </label>
            </Tooltip>
          {/each}
        </div>
      {/if}
    {/snippet}
  </FloatingCanvasPanel>
{/if}

<script module>
  /** Pure function. A self-contained SVG data URI for an <img> thumbnail.
   * @example dataUri("<svg/>").startsWith("data:image/svg+xml,") // true
   */
  function dataUri(svg) {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
</script>
