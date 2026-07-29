<!--
  Item Variables Panel (manifest item 67) — the SELECTED item's OWN keyframable
  variables. The item-scoped mirror of VariablesPanel: same three-part rows (name
  / equation-aware NumericField / ‹ ◆ › KeyframeControls), the same add/rename/
  delete affordances, one level deeper at ["items", itemId, "vars", name].

  Per-item vars are referenced from equations as `self.vars.<name>` (this item)
  or `<other>.vars.<name>` (cross-item) — a DOTTED spelling, disjoint from the
  bare-identifier global namespace, so a per-item and a global var may share a
  name with no collision. The whole point (user): tween ONE widget's own λ to
  morph its spiral, without a global that "defeats the purpose".

  Styling reuses .varspanel from app.css (app convention: no <style> blocks).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import NumericField from "./NumericField.svelte";
  import KeyframeControls from "./KeyframeControls.svelte";

  let { app, itemId } = $props();

  let names = $derived(Object.keys(app.itemVarsState(itemId)));
  let newName = $state("");

  function addVar() {
    if (!newName.trim()) return;
    if (app.addItemVariable(itemId, newName.trim())) newName = "";
  }

  function renameVar(oldName, e) {
    if (!app.renameItemVariable(itemId, oldName, e.target.value.trim())) e.target.value = oldName;
  }
</script>

<div class="varspanel">
  {#each names as name (name)}
    <div class="row">
      <input
        type="text"
        class="var-name"
        aria-label="Item variable name"
        value={name}
        onchange={(e) => renameVar(name, e)}
      />
      <NumericField {app} path={["items", itemId, "vars", name]} label={name} />
      <span class="kf-controls">
        <KeyframeControls {app} path={["items", itemId, "vars", name]} />
        <Tooltip text="Delete variable (all keyframes, all slides)">
          <button class="remove" aria-label="Delete item variable" onclick={() => app.deleteItemVariable(itemId, name)}>
            <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
          </button>
        </Tooltip>
      </span>
    </div>
  {:else}
    <div class="empty">No variables — add one, then reference it as "self.vars.NAME" from any numeric property to morph just this widget</div>
  {/each}
  <div class="row add-row">
    <input
      type="text"
      class="var-name"
      data-hint-scope="add"
      placeholder="new_variable"
      aria-label="New item variable name"
      spellcheck="false"
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === "Enter") addVar();
        e.stopPropagation(); // typing must not trigger app shortcuts
      }}
    />
    <Tooltip text="Add variable to this widget (keyframed 0 on this slide)">
      <button class="btn" onclick={addVar}>Add</button>
    </Tooltip>
  </div>
</div>
