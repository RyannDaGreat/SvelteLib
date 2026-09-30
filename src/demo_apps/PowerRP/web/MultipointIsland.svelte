<!--
  MultipointIsland — the Multipoint section of the floating selected-handle bar
  (web/HandleToolbar.svelte hosts it), shown whenever the one selected widget's
  paint is Multipoint. The manifest's "In-canvas Multipoint editing — the island"
  states the design and why.

  IT OWNS NO ACTIONS. Every button is a CommandButton on a command-registry entry
  (web/multipointCanvas.js multipointCommands), so the palette, the island and the
  `C` key are three surfacings of one action, and a dead button explains itself
  through commandUnavailableReason with aria-disabled (never native disabled).
  The colour fields are the app's ColorField — no second picker — with the
  Multipoint write hook (`pairsFor`) and the first field's `open` bound to
  app.handleColorOpen, which a double-click or `C` sets.

  Styling lives in app.css (.multipoint-island*, reusing .canvas-toolbar-row,
  .canvas-toolbar-count, .text-format-sep, .handle-color-field and
  .paint-stops-multi-note); no <style> block, per the app convention.
-->
<script>
  import CommandButton from "./CommandButton.svelte";
  import ColorField from "./ColorField.svelte";
  import { MULTIPOINT_SOURCE_KINDS, islandColorFields, multipointModeArmed, selectedPathFlags } from "./multipointCanvas.js";
  import { parseMultipointHandleId } from "../core/paint_handles.js";

  let { app } = $props();

  /** Icon size — the .btn-icon glyph size HandleToolbar's own row uses, so the two
   *  rows of one panel line up. */
  const ICON = 18;
  const ADD_COMMANDS = MULTIPOINT_SOURCE_KINDS.map((kind) => `multipoint-add-${kind}`);

  // The live colour fields and path flags. Reading app.doc / slideIndex /
  // previewDelta / handleSelection here makes the derivation track exactly what
  // the queries read, the same reactive-deps idiom CanvasView's overlay uses.
  let colour = $derived.by(() => {
    app.doc; app.slideIndex; app.previewDelta; app.handleSelection;
    return islandColorFields(app);
  });
  let flags = $derived.by(() => {
    app.doc; app.slideIndex; app.handleSelection;
    return selectedPathFlags(app);
  });
  // The path group only means something once a Multipoint handle is selected;
  // before that the row is just "add / split", which keeps the resting island small.
  let handlesChosen = $derived(app.handleSelection.some((id) => parseMultipointHandleId(id) !== null));
</script>

<div class="multipoint-island" role="group" aria-label="Multipoint editing">
  <div class="canvas-toolbar-row">
    <span class="canvas-toolbar-count">Multipoint</span>
    {#each ADD_COMMANDS as id (id)}
      <CommandButton {app} {id} size={ICON} pressed={multipointModeArmed(app, id)} />
    {/each}
    <span class="text-format-sep"></span>
    <CommandButton {app} id="multipoint-split-path" size={ICON} pressed={multipointModeArmed(app, "multipoint-split-path")} />
    {#if handlesChosen}
      <span class="text-format-sep"></span>
      <CommandButton {app} id="multipoint-toggle-two-sided" size={ICON} pressed={flags.twoSided} />
      <CommandButton {app} id="multipoint-toggle-closed" size={ICON} pressed={flags.closed} />
      <CommandButton {app} id="multipoint-reverse" size={ICON} />
    {/if}
  </div>
  {#each colour.fields as field, i (field.side)}
    <div class="handle-color-field">
      <span class="multipoint-island-label">{field.label}</span>
      {#if i === 0}
        <ColorField {app} path={field.path} label={field.label} value={field.value} pairsFor={field.pairsFor} bind:open={app.handleColorOpen} />
      {:else}
        <ColorField {app} path={field.path} label={field.label} value={field.value} pairsFor={field.pairsFor} />
      {/if}
    </div>
  {/each}
  {#if colour.skipped.length}
    <p class="paint-stops-multi-note multipoint-island-note">Not editable here: {colour.skipped.join("; ")}.</p>
  {/if}
</div>
