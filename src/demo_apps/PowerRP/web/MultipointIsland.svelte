<!--
  MultipointIsland — the Multipoint section of the floating selected-handle bar
  (web/HandleToolbar.svelte hosts it), shown whenever the one selected widget's
  paint is Multipoint. The manifest's "In-canvas Multipoint editing — the island"
  states the design and why.

  The RAMP LIBRARY panel (gradient map / ramp along path) is the same
  MultipointRampLibrary the Inspector mounts, opened by the `multipoint-gradient-map`
  / `multipoint-apply-ramp` commands through app.multipointRampOpen.

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
  import MultipointRampLibrary from "./MultipointRampLibrary.svelte";
  import { MULTIPOINT_SOURCE_KINDS, islandColorFields, islandRampTargets, multipointModeArmed, selectedPathFlags } from "./multipointCanvas.js";
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
  // The ramp library's targets (committed fold) — the gradient map needs only the
  // widget; "ramp along path" needs exactly one selected path source.
  let ramps = $derived.by(() => {
    app.doc; app.slideIndex; app.handleSelection;
    return islandRampTargets(app);
  });
  let rampMode = $derived(app.multipointRampOpen === "fill" && ramps.fill ? "fill"
    : app.multipointRampOpen === "path" && ramps.path ? "path" : null);
  // The path group only means something once a Multipoint handle is selected;
  // before that the row is just "add / split / recolour", which keeps the resting island small.
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
    <span class="text-format-sep"></span>
    <CommandButton {app} id="multipoint-gradient-map" size={ICON} pressed={rampMode === "fill"} />
    {#if handlesChosen}
      <CommandButton {app} id="multipoint-apply-ramp" size={ICON} pressed={rampMode === "path"} />
    {/if}
    {#if handlesChosen}
      <span class="text-format-sep"></span>
      <CommandButton {app} id="multipoint-toggle-two-sided" size={ICON} pressed={flags.twoSided} />
      <CommandButton {app} id="multipoint-toggle-closed" size={ICON} pressed={flags.closed} />
      <CommandButton {app} id="multipoint-reverse" size={ICON} />
    {/if}
  </div>
  {#if rampMode}
    <!-- Keyed on the mode AND target so switching fill ↔ path, or to another path,
         remounts the library (its side/Reverse choices belong to one target). -->
    {#key rampMode + JSON.stringify(rampMode === "fill" ? ramps.fill : ramps.path.featurePath)}
      <div class="multipoint-island-ramps">
        <MultipointRampLibrary {app} mode={rampMode} showToggle={false}
          path={rampMode === "fill" ? ramps.fill : ramps.path.featurePath}
          twoSided={rampMode === "path" && ramps.path.twoSided}
          bind:open={() => true, (o) => { if (!o) app.multipointRampOpen = null; }} />
      </div>
    {/key}
  {/if}
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
