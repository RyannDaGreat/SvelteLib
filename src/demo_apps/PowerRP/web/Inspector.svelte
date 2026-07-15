<!--
  Inspector — properties of the selected item, rows declared BY THE PLUGIN
  (plugin.inspector), rendered generically. Every row carries keyframe
  controls per the manifest spec:
    ◆/◇  insert/remove keyframe for this property on the CURRENT slide
    ‹ ›  jump to prev/next slide holding a keyframe for it
  Editing a value always writes a keyframe on the current slide.

  Item selection uses SvelteLib's Dropdown (never the native <select>) and
  includes non-bbox widgets (blur layers) — selection doesn't require canvas
  geometry. Items are user-renamable (name lives on the creation slide).
  Delete = deactivate on this slide; Purge = remove from existence.
-->
<script>
  import "iconify-icon";
  import Dropdown from "../../../lib/Dropdown.svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import NumericField from "./NumericField.svelte";

  let { app } = $props();

  let nodes = $derived(app.nodes());
  let sel = $derived(app.selectedNode());
  let itemChoices = $derived(nodes.map((n) => ({ value: n.itemId, label: app.displayName(n.itemId) })));

  function coerce(kind, raw) {
    return kind === "number" ? Number(raw) : kind === "checkbox" ? Boolean(raw) : raw;
  }

  /**
   * Pure function. Normalizes a stored color to a lowercase #rrggbb string —
   * the format <input type="color"> requires and the swatch/hex text display.
   * Anything unparseable (missing/malformed) falls back to black.
   *
   * Examples:
   *     >>> hexColor("#7AA2F7")
   *     '#7aa2f7'
   *     >>> hexColor(undefined)
   *     '#000000'
   */
  function hexColor(value) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : "#000000";
  }

  /** Live preview while typing/dragging a field — viewport re-renders in real
   * time BEFORE commit (manifest rule); Enter/blur commits; Escape reverts. */
  function previewField(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) return;
    app.setPreview([[["items", app.selection, key], value]]);
  }

  function commitField(key, kind, raw) {
    const value = coerce(kind, raw);
    if (kind === "number" && Number.isNaN(value)) {
      app.cancelPreview();
      return;
    }
    app.setPreview([[["items", app.selection, key], value]]);
    app.commitPreview();
  }

  function fieldKeydown(e) {
    if (e.key === "Escape") {
      app.cancelPreview();
      e.target.blur();
      e.stopPropagation();
    }
  }

  function toggleKey(key) {
    // Dotted keys are nested paths (arrow "from.x"). Inserting a keyframe
    // copies the RAW stored value — an equation keyframes as the equation.
    const path = key.split(".");
    if (app.hasKey(key)) app.removeKey(app.slideIndex, ["items", app.selection, ...path]);
    else app.keyframePath(["items", app.selection, ...path], app.storedItemValue(app.selection, path));
  }
</script>

<div class="inspector">
  <div class="inspector-head">
    <Dropdown
      items={itemChoices}
      value={app.selection}
      placeholder="— select item —"
      onchange={(v) => (app.selection = v)}
    />
  </div>

  {#if sel}
    {#if sel.plugin.capabilities.purgeable !== false}
      <div class="item-actions">
        <Tooltip text="Deactivate on this slide (item survives on earlier slides)">
          <button class="btn" onclick={() => app.runCommand("delete-item")}>Delete here</button>
        </Tooltip>
        <Tooltip text="Remove from existence (all keyframes, all slides)">
          <button class="btn danger" onclick={() => app.runCommand("purge-item")}>Purge</button>
        </Tooltip>
      </div>
    {/if}
    <div class="row name-row">
      <span class="label">Name</span>
      <input
        type="text"
        placeholder={app.displayName(sel.itemId)}
        value={sel.state.name ?? ""}
        onchange={(e) => app.renameSelection(e.target.value)}
      />
    </div>
    <div class="rows">
      {#each sel.plugin.inspector ?? [] as row (row.key)}
        <div class="row">
          <span class="label">{row.label}</span>
          {#if row.kind === "number"}
            <!-- NumericField: equation-aware (THE UNIFICATION). A number
                 renders as the DraggableNumber scrubber; an equation renders
                 as a monospace expression editor with live evaluation and the
                 error affordance; the ƒ/№ toggle converts between them.
                 Dotted keys ("from.x") address nested state. -->
            <NumericField
              {app}
              path={["items", app.selection, ...row.key.split(".")]}
              label={row.label}
              min={row.min ?? null}
              max={row.max ?? null}
            />
          {:else if row.kind === "color"}
            <!-- A themed control shaped like the number/text inputs (same
                 --a-input-w × --a-control-h, square, 1px border). The native
                 <input type="color"> is stretched invisibly over the whole
                 control so a click anywhere opens Chrome's picker; the visible
                 swatch + hex text show the CURRENT folded (preview-inclusive)
                 value. oninput/onchange keep the exact preview/commit wiring. -->
            <label class="color-control">
              <input
                type="color"
                class="color-native"
                value={hexColor(sel.state[row.key])}
                oninput={(e) => previewField(row.key, row.kind, e.target.value)}
                onchange={(e) => commitField(row.key, row.kind, e.target.value)}
              />
              <span class="color-swatch" style:background={hexColor(sel.state[row.key])}></span>
              <span class="color-hex">{hexColor(sel.state[row.key])}</span>
            </label>
          {:else if row.kind === "checkbox"}
            <input
              type="checkbox"
              checked={Boolean(sel.state[row.key])}
              onchange={(e) => commitField(row.key, row.kind, e.target.checked)}
            />
          {:else}
            <input
              type="text"
              value={sel.state[row.key] ?? ""}
              oninput={(e) => previewField(row.key, row.kind, e.target.value)}
              onchange={(e) => commitField(row.key, row.kind, e.target.value)}
              onkeydown={fieldKeydown}
            />
          {/if}
          <!-- prev ◆ next — jumps hug the diamond (manifest spec); hollow =
               not keyed on this slide, filled = keyed. Iconify, never Unicode. -->
          <Tooltip text="Previous keyframe">
            <button class="jumpbtn" aria-label="Previous keyframe" onclick={() => app.jumpKeyframe(row.key, -1)}>
              <iconify-icon icon="mdi:chevron-left" width="16" height="16"></iconify-icon>
            </button>
          </Tooltip>
          <Tooltip text={app.hasKey(row.key) ? "Remove keyframe on this slide" : "Insert keyframe on this slide"}>
            <button
              class="keybtn"
              class:keyed={app.hasKey(row.key)}
              aria-label="Toggle keyframe on this slide"
              onclick={() => toggleKey(row.key)}
            >
              <iconify-icon icon={app.hasKey(row.key) ? "mdi:rhombus" : "mdi:rhombus-outline"} width="17" height="17"></iconify-icon>
            </button>
          </Tooltip>
          <Tooltip text="Next keyframe">
            <button class="jumpbtn" aria-label="Next keyframe" onclick={() => app.jumpKeyframe(row.key, +1)}>
              <iconify-icon icon="mdi:chevron-right" width="16" height="16"></iconify-icon>
            </button>
          </Tooltip>
        </div>
      {/each}
    </div>
  {:else}
    <div class="empty">Nothing selected</div>
  {/if}
</div>
