<!--
  Tools Pane — the pane of ACTIONS that operate on the current selection.

  THIS FILE HAS NO TOOL LIST. It renders `plugin.toolGroups`, which
  core/registry.js resolves at REGISTRATION from the TOOL POOL plus whatever the
  plugin declares (see the "TOOL GROUPS" block there for the model and the
  reasoning). So the pane knows nothing about which tools exist, which widget has
  which, or which are empty — it is a renderer for a resolved shape. Adding a tool
  is a line in the pool (or in a plugin), never an edit here.

  WHY IT IS BUILT THAT WAY (the user's complaint, verbatim): "why is Presets UNDER
  Formatting? A submenu under formatting? No, these should be TOP-LEVEL menus. And
  by the way, if there's nothing in a submenu, it doesn't need to show it. If there
  are no formatting tools, we don't need to see the formatting drop-down in Tools.
  ... Presets is fine as a button, but the button is now a drop-down — a drop-down
  inside a drop-down is stupid. It should be its OWN drop-down. Widgets should be
  able to OWN what type of tool submenus they have in Tools." Three consequences
  are visible in the markup below:
    - ONE disclosure level. A GROUP IS the drop-down: its accordion header opens
      it and its rows are the content. A preset list is a group of preset rows,
      not a toggle inside another group's rows, so the nested disclosure is gone.
    - PRESETS IS TOP-LEVEL, and a widget with several orthogonal preset FAMILIES
      (Mandelbrot: location / colour / performance) gets one top-level group each.
    - AN EMPTY GROUP CANNOT REACH HERE. Groups arrive already filtered by
      applicability, so there is no "hide if empty" branch to forget: a rect has no
      preset group at all, a blur layer has no Positioning group, and with nothing
      selected there are no groups (the pane shows one empty state instead of a
      stack of dead controls).

  Nothing here has behavior of its own. A COMMAND row is a surfacing of a
  command-registry entry, exactly like a Toolbar button or a palette row: the
  registry owns `title`, `icon`, the `when` guard that grays it out, and `run`. A
  PRESET row surfaces app.applyPreset the same way.

  A DISABLED ROW EXPLAINS ITSELF. `when` says only THAT a command cannot run, so
  the tool declares `requires` — the sentence completing "Unavailable — requires …"
  — and the tooltip shows it beneath the help. Mandatory on every pool tool (the
  import gate in core/registry.js throws otherwise), so a mystery gray button is
  not expressible. A row whose command has no gate simply never shows a reason.
  The same sentence, the same class and the same precedence now appear on
  web/Toolbar.svelte's buttons, so a disabled control explains itself the same way
  wherever it is surfaced.

  HOVER LIVE-PREVIEWS, the house trope for pickers (the preset cards established
  it): hovering a preset row, or a command row whose entry declares
  core/commands.js's `preview(app) -> revert` protocol, stages the change into
  app.previewDelta — the viewport renders it, the document is UNTOUCHED and no undo
  entry is created. The next hover overwrites it; leaving the group's rows reverts;
  clicking commits durably (ONE undo unit). Same highlight → preview → revert
  contract the command palette drives.

  There is no save/load-your-own preset here by design (built-in presets only).
  (The Escape-closes-the-list handler died with the nested list: the accordion is
  the disclosure now, and the shared accordion — web/Inspector.svelte's — has no
  Escape binding to match.)

  Styling lives in app.css (.toolspane; app convention: no <style> blocks).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { commandUnavailable } from "../core/commands.js";
  import { presetsForMaterial, materialDisplayName } from "../render_gpu/skia/material_presets.js";

  let { app } = $props();

  // The selected item and the groups ITS plugin exposes (reactive off selection +
  // doc). No selection → no plugin → no groups → the empty state.
  let node = $derived(app.selectedNode());

  // The Tools groups: the plugin's OWN (widget-type) groups FOLLOWED BY groups
  // derived from the selection's CURRENT MATERIALS (manifest D.10). The material
  // groups are ADDITIVE — a rect carrying the sky material as its fill gets the
  // sky's presets even though the rect plugin declares none. Reactive off
  // app.state(), so keyframing a slot to/from a material adds/drops its section.
  let groups = $derived([...(node?.plugin?.toolGroups ?? []), ...materialGroups()]);

  /**
   * Query. The preset groups for the SELECTED item's current fill/stroke material
   * paints — one section per slot whose paint is `{type:"material", material:{id}}`
   * and whose material ships presets (material_presets.js). Reads the FOLDED state
   * (app.state), so a tweened/keyframed material is seen. Returns [] when nothing
   * is selected, or neither slot carries a preset-bearing material.
   *
   * The title is SPECIFIC to the material and slot (manifest D.11): fill →
   * "Sky material presets", stroke → "Brush stroke presets" — never a generic
   * "fill material presets".
   */
  function materialGroups() {
    if (app.selection == null) return [];
    const state = app.state().items?.[app.selection];
    if (!state) return [];
    const out = [];
    for (const slot of ["fill", "stroke"]) {
      const paint = state[slot];
      if (!paint || paint.type !== "material" || !paint.material?.id) continue;
      const id = paint.material.id;
      const presets = presetsForMaterial(id, app.registry); // widget presets FIRST (Round 4 #52), curated extras after
      if (!presets.length) continue;
      const noun = slot === "stroke" ? "stroke" : "material";
      out.push({
        id: `matpreset:${slot}:${id}`,
        title: `${materialDisplayName(id)} ${noun} presets`,
        rows: presets.map((p) => ({
          kind: "materialPreset",
          slot,
          preset: { name: p.title, description: p.description, params: p.params },
        })),
      });
    }
    return out;
  }

  // Collapsed sections persist as a BROWSER setting (the Inspector's own rule for
  // collapse state), under this pane's OWN key: collapsing "Positioning" here
  // must not also collapse the Property Panel's Positioning rows — different
  // content that happens to share a heading.
  const COLLAPSE_KEY = "powerrp.toolsCollapsed";
  let collapsed = $state(loadCollapsed());

  /** Query. The persisted collapse map, or {} when absent/corrupt (a bad setting
   * is reported and ignored — it must not brick the pane). */
  function loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn("PowerRP: bad toolsCollapsed setting, ignoring:", e);
      return {};
    }
  }

  /** Command. Toggles a section's collapse and persists the map. Reverts any live
   * hover preview first: collapsing unmounts the rows with the pointer still over
   * one, which fires no pointerleave, so the revert must not depend on one. */
  function toggleCategory(id) {
    revertPreview();
    collapsed = { ...collapsed, [id]: !collapsed[id] };
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
  }

  // ── Rows ────────────────────────────────────────────────────────────────────
  // previewRevert is PLAIN (not $state), the CommandPalette precedent: it is a
  // bridge to an imperative preview, never rendered. ONE closure for both row
  // kinds, so hovering from a preset onto a command tool (or back) overwrites the
  // staged preview through exactly one path.
  let previewRevert = null;

  /** Query. The registry entry a command row surfaces (loud on a bad id — a pool
   * tool naming an unregistered command is a wiring bug, not a soft state). */
  function entryOf(row) {
    return app.commands.get(row.command);
  }

  /**
   * Query. Can this row NOT run right now? A command row asks its own registry
   * `when` guard — which is what keeps tools GENERAL: the camera-bind pair is
   * gated by the selection HAVING the frame properties, never by a widget type.
   * Preset rows are never gated: their group exists only because the plugin
   * declared the presets, and there is a selection to apply them to.
   *
   * SEPARATE FROM THE REASON, deliberately: whether a control is disabled must not
   * depend on whether anyone wrote prose for it. The pool's import gate makes
   * `requires` mandatory, so the two answers agree today — but a command surfaced
   * from elsewhere with a `when` and no sentence would otherwise render ENABLED
   * and no-op on click. web/Toolbar.svelte splits them the same way.
   */
  function unavailable(row) {
    if (row.kind !== "command") return false;
    return commandUnavailable(entryOf(row), app);
  }

  /**
   * Query. WHY this row cannot run right now, or null when it can (or when
   * nothing declares a reason).
   *
   * The reason comes from the COMMAND when the entry declares one and from the
   * tool otherwise. Precedence that way round because `requires` explains `when`,
   * and `when` belongs to the entry — so once web/App.svelte's entries carry their
   * own `requires` (the handback patch), every surfacing gets it and the pool's
   * copies can be deleted with no change here.
   */
  function unavailableReason(row) {
    return unavailable(row) ? (entryOf(row).requires ?? row.requires ?? null) : null;
  }

  /**
   * Command. Live-previews a row WITHOUT committing. Reverts any previous preview
   * first, so moving between rows overwrites cleanly. A command whose entry has no
   * `preview`, or a disabled row, previews nothing (expected, not an error).
   */
  function previewRow(row) {
    revertPreview();
    if (unavailable(row)) return;
    if (row.kind === "command") previewRevert = previewCommand(row);
    else if (row.kind === "materialPreset") previewRevert = previewMaterialPreset(row);
    else previewRevert = previewPreset(row.preset);
  }

  /** Command. Reverts the live preview (pointer left the group's rows, or a
   * section collapsed under it). */
  function revertPreview() {
    if (previewRevert) previewRevert();
    previewRevert = null;
  }

  /** Command. Stages a command's preview via its `preview(app) -> revert`
   * (core/commands.js) and RETURNS that revert closure, or null when the entry
   * declares none. */
  function previewCommand(row) {
    const cmd = entryOf(row);
    return cmd.preview ? cmd.preview(app) : null;
  }

  /**
   * Command. Stages `preset` on the selected item WITHOUT committing — its props
   * go into app.previewDelta (the viewport renders it; the doc is untouched and
   * no undo entry is created) — and RETURNS the revert closure. Stages
   * nothing with no selection or no props (expected control flow, not an error).
   *
   * @param {{props: Object}} preset - a plugin preset descriptor ({name, props, ...})
   * @example previewPreset({ name: "Cinematic", props: { anamorphic: 0.38 } })
   *   // app.previewDelta.items[app.selection].anamorphic === 0.38
   */
  function previewPreset(preset) {
    if (app.selection == null || !preset?.props) return null;
    const pairs = Object.entries(preset.props).map(([key, value]) => [["items", app.selection, key], value]);
    app.setPreview(pairs);
    return () => app.cancelPreview();
  }

  /**
   * Query. The setPreview path/value pairs for a MATERIAL preset row: each of the
   * preset's sparse knobs is written to the paint's OWN params — ["items", sel,
   * <slot>, "material", "params", <knob>] — NOT to a top-level item key (that is
   * what separates a material preset from a plugin preset). Only the knobs the
   * preset names are written, so the material's other knobs keep their value.
   *
   * @param {{slot: string, preset: {params: object}}} row - a materialPreset row
   */
  function materialPresetPairs(row) {
    return Object.entries(row.preset.params).map(
      ([knob, value]) => [["items", app.selection, row.slot, "material", "params", knob], value]
    );
  }

  /**
   * Command. Live-previews a MATERIAL preset via the SAME app.previewDelta trope
   * every ToolsPane row uses (the doc is untouched; no undo entry) and RETURNS the
   * revert closure. Stages nothing with no selection (expected control flow).
   *
   * NOTE FOR THE INTEGRATOR (hover-preview unification): this reuses ToolsPane's
   * own preview seam, which works today. The INSPECTOR agent is building a reusable
   * hover-preview helper in PaintField's domain (PaintField material knob rows). If
   * that helper is later adopted here to share one preview code path across the
   * pane and the Inspector, THIS is the call site to route through it — it already
   * has the clean preview(fn)→revert shape it expects.
   */
  function previewMaterialPreset(row) {
    if (app.selection == null) return null;
    app.setPreview(materialPresetPairs(row));
    return () => app.cancelPreview();
  }

  /**
   * Command. Runs a row durably. Drops the revert closure WITHOUT calling it —
   * the palette's commit rule: the previewed change stays and the commit path
   * makes it a real, single-undo-unit edit (app.runCommand for a command,
   * app.applyPreset for a preset).
   *
   * A picked preset leaves its group OPEN, deliberately: presets are meant to be
   * COMPARED, so the next one is one hover away; and collapsing would shrink the
   * pane content under a stationary cursor, which re-fires pointerenter on
   * whichever row slides beneath it — measured, that staged an unrelated
   * Bind-to-Camera preview the instant a preset was picked.
   */
  function runRow(row) {
    previewRevert = null;
    if (row.kind === "command") app.runCommand(row.command);
    else if (row.kind === "materialPreset") { app.setPreview(materialPresetPairs(row)); app.commitPreview(); }
    else app.applyPreset(app.selection, row.preset);
  }
</script>

<div class="toolspane">
  {#if groups.length === 0}
    <!-- Three honest empty states, not one. The middle one exists because
         app.selectedNode() is null for an item that is SELECTED but not on this
         slide (the Property Panel's "Not created yet on this slide" case): saying
         "select a widget" there would be a lie about what the user just did. -->
    <div class="empty">
      {#if node}
        {node.plugin.title ?? node.plugin.type} has no tools.
      {:else if app.selection != null}
        Not on this slide — nothing to act on here.
      {:else}
        Select a widget to see its tools.
      {/if}
    </div>
  {/if}
  {#each groups as group (group.id)}
    <!-- The group accordion, same markup/classes as Inspector.svelte's category
         accordion: header toggles collapse, chevron reflects state, body renders
         only when expanded. THIS header is the drop-down the user asked for —
         there is no second toggle inside it. -->
    <div class="prop-category">
      <button class="cat-header" aria-expanded={!collapsed[group.id]} onclick={() => toggleCategory(group.id)}>
        <iconify-icon icon={collapsed[group.id] ? "mdi:chevron-right" : "mdi:chevron-down"} width="16" height="16"></iconify-icon>
        <span class="cat-title">{group.title}</span>
      </button>
      {#if !collapsed[group.id]}
        <!-- pointerleave sits on the ROWS container, not each row: it fires only
             when the pointer leaves the group entirely, while moving BETWEEN rows
             fires each row's pointerenter, which overwrites the staged preview
             without a revert in between. A passive sensor, like Panel.svelte's.
             The container is height-capped and scrolls internally (app.css), so a
             long preset library cannot run off the pane. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="cat-rows" onpointerleave={revertPreview}>
          {#each group.rows as row, i (row.kind === "command" ? row.command : `${row.preset.name}-${i}`)}
            {#if row.kind === "command"}
              {@const reason = unavailableReason(row)}
              <Tooltip>
                {#snippet tip()}
                  <div>{row.help}</div>
                  <!-- The WHY, beneath the what. Rendered only when the row is
                       actually disabled, so it reads as the live reason rather
                       than a standing caveat. -->
                  {#if reason}<div class="tool-tip-requires">Unavailable — requires {reason}</div>{/if}
                {/snippet}
                <button
                  class="btn tool-action"
                  disabled={unavailable(row)}
                  onpointerenter={() => previewRow(row)}
                  onclick={() => runRow(row)}
                >
                  <iconify-icon icon={entryOf(row).icon} width="16" height="16"></iconify-icon>
                  <span class="tool-action-label">{entryOf(row).title}</span>
                </button>
              </Tooltip>
            {:else}
              <!-- A preset row: the SAME standard control as a command row (one
                   .btn, one height, one font), plus .tool-preset's preview-tinted
                   hover. Its DESCRIPTION is the hover tip rather than a second
                   line in the row — that is what keeps a whole family on screen in
                   a right-column pane, and it is how the gradient library labels
                   its swatches. -->
              <Tooltip text={row.preset.description ?? `Apply the ${row.preset.name} preset to the current frame`}>
                <button
                  class="btn tool-action tool-preset"
                  onpointerenter={() => previewRow(row)}
                  onclick={() => runRow(row)}
                >
                  <span class="tool-action-label">{row.preset.name}</span>
                </button>
              </Tooltip>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
