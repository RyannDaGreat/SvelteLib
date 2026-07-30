<!--
  Variables Panel — the keyframable variables editor (THE UNIFICATION).

  Variables live in state.vars ({name: number | equation}) and tween like any
  state: keyframe a variable per slide and every equation referencing it
  follows the tween. Each row mirrors a Property Panel row: name (rename
  rewrites references document-wide — a variable's name IS its identity),
  an equation-aware NumericField, and the standard ‹ ◆ › keyframe controls
  on path ["vars", name]. Delete removes the variable from existence (all
  keyframes, all slides — the variables' Purge). The add row creates the
  variable keyframed at 0 on the CURRENT slide (same visibility philosophy
  as item creation: things begin on the slide where you make them).

  Styling lives in app.css (.varspanel; app convention: no <style> blocks).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import NumericField from "./NumericField.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";
  import LabelDivider from "./LabelDivider.svelte";

  let { app } = $props();

  let names = $derived(Object.keys(app.varsState()));
  let newName = $state("");

  function addVar() {
    if (!newName.trim()) return;
    if (app.addVariable(newName.trim())) newName = "";
  }

  function renameVar(oldName, e) {
    if (!app.renameVariable(oldName, e.target.value.trim())) e.target.value = oldName;
  }
</script>

<div class="varspanel">
  <!-- The variable rows are wrapped in a .rows BLOCK (the Inspector's container,
       reused) for two reasons that are really one: it is the measuring box the
       label⟷value divider reads, and it is the box the divider spans. Without it
       the divider would have to measure the whole panel — including the add-row
       below, which opts OUT of the value-column grid — and would then sit a few
       pixels off the boundary it is supposed to name. The rows themselves are
       unchanged; only their parent is new. -->
  <div class="rows">
    <!-- ONE fraction, both panels: the divider here and the ones in the Property
         Panel are readouts of app.labelFrac, so dragging either keeps the two
         panels' columns in x-sync (the round-11 "columns line up" ruling). -->
    {#if names.length > 0}<LabelDivider {app} />{/if}
    {#each names as name (name)}
      <div class="row">
        <input
          type="text"
          class="var-name"
          aria-label="Variable name"
          value={name}
          onchange={(e) => renameVar(name, e)}
        />
        <NumericField {app} path={["vars", name]} label={name} />
        <!-- Trailing controls grouped in ONE grid cell (matches the Property
             Panel rows): the shared ‹ ◆ › KeyframeControls + a delete button
             appended in the same cell. Keeps the value column growing while these
             stay aligned across both panels. -->
        <span class="kf-controls">
          <KeyframeControls {app} path={["vars", name]} />
          <Tooltip text="Delete variable (all keyframes, all slides)">
            <button class="remove" aria-label="Delete variable" onclick={() => app.deleteVariable(name)}>
              <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
            </button>
          </Tooltip>
        </span>
      </div>
    {:else}
      <div class="empty">No variables — add one below, then reference it from any numeric property (e.g. "speed * 2")</div>
    {/each}
  </div>
  <div class="row add-row">
    <input
      type="text"
      class="var-name"
      data-hint-scope="add"
      placeholder="new_variable"
      aria-label="New variable name"
      spellcheck="false"
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === "Enter") addVar();
        e.stopPropagation(); // typing must not trigger app shortcuts
      }}
    />
    <Tooltip text="Add variable (keyframed 0 on this slide)">
      <button class="btn" onclick={addVar}>Add</button>
    </Tooltip>
  </div>
</div>
