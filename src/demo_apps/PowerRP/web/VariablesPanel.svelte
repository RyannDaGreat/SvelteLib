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

  function toggleKey(name) {
    const path = ["vars", name];
    if (app.hasKeyPath(path)) app.removeKey(app.slideIndex, path);
    else app.keyframePath(path, app.varsState()[name]);
  }
</script>

<div class="varspanel">
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
      <Tooltip text="Previous keyframe">
        <button class="jumpbtn" aria-label="Previous keyframe" onclick={() => app.jumpKeyframePath(["vars", name], -1)}>
          <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
      <Tooltip text={app.hasKeyPath(["vars", name]) ? "Remove keyframe on this slide" : "Insert keyframe on this slide"}>
        <button
          class="keybtn"
          class:keyed={app.hasKeyPath(["vars", name])}
          aria-label="Toggle keyframe on this slide"
          onclick={() => toggleKey(name)}
        >
          <iconify-icon icon={app.hasKeyPath(["vars", name]) ? "mdi:rhombus" : "mdi:rhombus-outline"} width="17" height="17"></iconify-icon>
        </button>
      </Tooltip>
      <Tooltip text="Next keyframe">
        <button class="jumpbtn" aria-label="Next keyframe" onclick={() => app.jumpKeyframePath(["vars", name], +1)}>
          <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
        </button>
      </Tooltip>
      <Tooltip text="Delete variable (all keyframes, all slides)">
        <button class="remove" aria-label="Delete variable" onclick={() => app.deleteVariable(name)}>
          <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
        </button>
      </Tooltip>
    </div>
  {:else}
    <div class="empty">No variables — add one below, then reference it from any numeric property (e.g. "speed * 2")</div>
  {/each}
  <div class="row add-row">
    <input
      type="text"
      class="var-name"
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
