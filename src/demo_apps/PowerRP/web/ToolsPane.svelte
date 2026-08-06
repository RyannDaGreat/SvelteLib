<!--
  Tools Pane — the pane of ACTIONS that operate on the current selection.

  THIS FILE HAS NO TOOL LIST. It renders `app.multiToolPanel()`, which resolves the
  selection's groups from each item's own resolved `toolGroups` (core/registry.js
  owns the TOOL POOL model and the reasoning) through core/multiselect.js's
  intersection. So the pane knows nothing about which tools exist, which widget has
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
      preset group at all, a blur layer has no Transform group, and with nothing
      selected there are no groups (the pane shows one empty state instead of a
      stack of dead controls).

  ── A MULTI-SELECTION GETS THE INTERSECTION OR THE UNION ──────────────────────
  USER, 2026-08-06 (verbatim): "When I select multiple objects, just like
  properties, I sholud be able to select intersection OR union of available tools -
  and then when I click a tool, it does it to all selected objects. Tools have the
  option to specify what happens or if they're allowed to be done in a plural
  selection - copy tool already does this so it might not be so bad . But
  whypresets dont do this?"

  THE PANE USED TO BE PRIMARY-ONLY — `app.selectedNode()`'s plugin's groups, and
  `app.applyPreset(app.selection, …)`. With a rect and a video selected it showed
  the RECT's tools and the video's were unreachable, and a preset click landed on
  one widget out of five in silence. Now there is ONE path for every selection
  size: core/multiselect.js returns a one-item selection's own groups and rows BY
  IDENTITY, so the single-selection pane is unchanged by construction rather than by
  a second branch here.

  WHAT EACH OF THE FOUR ASKS RESOLVED TO:
    - INTERSECTION ⇄ UNION is the SAME control and the SAME state as the Property
      Panel's (web/MultiSelectModeToggle.svelte over app.multiSelectMode) — "just
      like properties" taken literally, one state in two elements.
    - A PRESET CLICK fans out over the items the row applies to, as ONE undo unit
      (app.applyPresetRow → setPreview → commitPreview, the seam app.unifySelection
      already uses). That is the answer to "why don't presets do this?": nothing
      refused them, the target was simply hard-wired to app.selection.
    - A COMMAND CLICK runs the registry entry, which takes the SELECTION as its
      subject — `copySelection`, `deleteSelection`, `duplicateSelection` and the
      rest all read `selectedIds()`. The pane does not loop them: a command that
      fanned out from here would commit N undo units.
    - WHETHER A TOOL IS ALLOWED over a plural selection is the AVAILABILITY axis,
      unchanged: `shatterBlocker` says "one widget selected, not several — shatter
      makes one group at a time", the light pin's `requires` says "a multi-selection
      has no single widget to pin from". Those render DISABLED with their sentence
      below, exactly as any other gate does.
    - WHAT a plural click does is the entry's optional `plural` declaration
      (core/commands.js PLURAL_SCOPE), shown only when the selection IS plural.

  Nothing here has behavior of its own. A COMMAND row is a surfacing of a
  command-registry entry, exactly like a Toolbar button or a palette row: the
  registry owns `title`, `icon`, the `when` guard that grays it out, and `run`. A
  PRESET row surfaces app.applyPresetRow the same way.

  A DISABLED ROW EXPLAINS ITSELF. `when` says only THAT a command cannot run, so
  the ENTRY declares `requires` — the sentence completing "Unavailable — requires …"
  — and the tooltip shows it beneath the help. A row whose command has no gate
  simply never shows a reason. The same sentence, the same class and the same
  precedence appear on web/Toolbar.svelte's buttons, so a disabled control explains
  itself the same way wherever it is surfaced.

  EVERY WORD A ROW RENDERS COMES FROM THE COMMAND ENTRY — title, icon, help,
  requires. The pool row carries only which command and which widgets it suits, so
  there is one copy of each sentence and nothing to keep in sync; the mandate that
  a gated command HAVE a `requires` moved to tests/tool_surfacing_probe.js, which
  asks the live registry. `help` is optional on an entry (core/commands.js: "absent
  on the obvious ones"), so a row with neither help nor a live reason renders with
  NO tooltip rather than an empty one — the palette's rule, that the help section
  is absent rather than empty.

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
  import MultiSelectModeToggle from "./MultiSelectModeToggle.svelte";
  import { commandUnavailable, commandUnavailableReason, unavailableMessage, pluralScopeNote } from "../core/commands.js";

  let { app } = $props();

  // THE resolved pane. Reactive off selection + doc + mode, because
  // app.multiToolPanel reads all three: keyframing a paint slot to a material adds
  // that material's preset section, and flipping the mode changes which rows are in.
  let panel = $derived(app.multiToolPanel());
  let groups = $derived(panel.groups);
  // How many items the pane is ACTING ON — the live ones, not the selected count:
  // an item that is not on this slide has no folded state to act on and is reported
  // in `panel.skipped` instead (core/multiselect.js's rule, shared with the
  // Property Panel).
  let actingCount = $derived(panel.itemIds.length);
  let plural = $derived(actingCount > 1);
  // The PRIMARY's node, for the one empty state that names a widget type. Nothing
  // else reads it — the groups no longer come from here.
  let primary = $derived(app.selectedNode());

  // Collapsed sections persist as a BROWSER setting (the Inspector's own rule for
  // collapse state), under this pane's OWN key: collapsing "Transform" here
  // must not also collapse the Property Panel's Transform rows — different
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
  // A ROW ARRIVES WRAPPED: {key, row, appliesTo}. `row` is the plugin's or the
  // pool's OWN object, by reference (core/multiselect.js's drift gate — "a
  // reference cannot drift from itself"), and `appliesTo` is which selected items
  // declared it, which in UNION mode may be a subset. Everything below takes the
  // WRAPPER, so a write can never reach an item whose widget never offered the tool.
  //
  // previewRevert is PLAIN (not $state), the CommandPalette precedent: it is a
  // bridge to an imperative preview, never rendered. ONE closure for every row
  // kind, so hovering from a preset onto a command tool (or back) overwrites the
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
   * gated by the selection HAVING the frame properties, never by a widget type, and
   * a tool that refuses a PLURAL selection refuses through that same gate. Preset
   * rows are never gated: their group exists only because a selected item declared
   * the presets, and there are items to apply them to.
   *
   * SEPARATE FROM THE REASON, deliberately: whether a control is disabled must not
   * depend on whether anyone wrote prose for it, or a gated command with no
   * sentence would render ENABLED and no-op on click. web/Toolbar.svelte splits
   * them the same way.
   */
  function unavailable(entry) {
    if (entry.row.kind !== "command") return false;
    return commandUnavailable(entryOf(entry.row), app);
  }

  /**
   * Query. Everything the markup needs to know about one command row, resolved in
   * ONE pass: its entry, whether it is disabled, the live reason if so, and the
   * sentence its declared plural scope promises (null unless the selection is
   * plural AND the entry declares one).
   *
   * IT EXISTS TO ASK EACH GATE EXACTLY ONCE PER RENDER. The markup used to call
   * `unavailable(row)` for the disabled attribute and `unavailableReason(row)`
   * for the tip, and the latter asked the gate again — three evaluations per row.
   * That was survivable while the pane offered five tools; it is not now that it
   * offers ~40, because a `when` is not free. Six Arrange rows share
   * `needsMultiBbox`, which derives the whole render tree, so the old shape would
   * have derived it eighteen times for one paint of one section. (The lesson is
   * already written down against `shatterBlocker`: an expensive gate re-evaluated
   * on every availability pass once pushed a probe over its budget.)
   *
   * THE REASON GOES THROUGH commandUnavailableReason, not `.requires` directly,
   * because a `requires` MAY BE A FUNCTION of the app (a gate with several
   * disqualifying conditions has several true sentences — see that function's
   * note, and `save-project`). Reading the field raw would render a function's
   * source text into the pane.
   *
   * @param {{row: {kind: string, command: string}}} entry - a resolved command row wrapper
   * @returns {{cmd: object, disabled: boolean, reason: string|null, pluralNote: string|null}}
   */
  function commandRow(entry) {
    const cmd = entryOf(entry.row);
    const disabled = commandUnavailable(cmd, app);
    return {
      cmd,
      disabled,
      reason: disabled ? commandUnavailableReason(cmd, app) : null,
      pluralNote: plural ? pluralScopeNote(cmd) : null,
    };
  }

  /**
   * Query. The sentence naming WHICH selected items a row acts on, or null when it
   * acts on all of them (or when there is only one). It is the union mode's honesty
   * line: a row only some items declare still runs, and this says on how many —
   * the same fact the Property Panel puts on a union row.
   *
   * @param {{appliesTo: string[]}} entry - a resolved row wrapper
   * @returns {string|null}
   */
  function scopeNote(entry) {
    if (!plural || entry.appliesTo.length === actingCount) return null;
    return `Applies to ${entry.appliesTo.length} of the ${actingCount} selected widgets — the ones that have this tool: ${entry.appliesTo.map((id) => app.displayName(id)).join(", ")}`;
  }

  /**
   * Command. Live-previews a row WITHOUT committing. Reverts any previous preview
   * first, so moving between rows overwrites cleanly. A command whose entry has no
   * `preview`, or a disabled row, previews nothing (expected, not an error).
   */
  function previewRow(entry) {
    revertPreview();
    if (unavailable(entry)) return;
    if (entry.row.kind === "command") {
      const cmd = entryOf(entry.row);
      previewRevert = cmd.preview ? cmd.preview(app) : null;
      return;
    }
    // A PRESET previews over the SAME items the click will write, so hover and
    // commit cannot disagree about scope.
    app.previewPresetRow(entry.appliesTo, entry.row);
    previewRevert = () => app.cancelPreview();
  }

  /** Command. Reverts the live preview (pointer left the group's rows, or a
   * section collapsed under it). */
  function revertPreview() {
    if (previewRevert) previewRevert();
    previewRevert = null;
  }

  /**
   * Command. Runs a row durably. Drops the revert closure WITHOUT calling it —
   * the palette's commit rule: the previewed change stays and the commit path
   * makes it a real, single-undo-unit edit (app.runCommand for a command,
   * app.applyPresetRow for either kind of preset).
   *
   * A COMMAND IS NOT LOOPED HERE. Its `run` takes the SELECTION as its subject
   * (copySelection, deleteSelection, duplicateSelection … all read selectedIds),
   * so running it once acts on everything selected — and looping it would commit
   * one undo unit per item, which is exactly what the preset fan-out avoids.
   *
   * A picked preset leaves its group OPEN, deliberately: presets are meant to be
   * COMPARED, so the next one is one hover away; and collapsing would shrink the
   * pane content under a stationary cursor, which re-fires pointerenter on
   * whichever row slides beneath it — measured, that staged an unrelated
   * Bind-to-Camera preview the instant a preset was picked.
   */
  function runRow(entry) {
    previewRevert = null;
    if (entry.row.kind === "command") app.runCommand(entry.row.command);
    else app.applyPresetRow(entry.appliesTo, entry.row);
  }
</script>

<div class="toolspane">
  {#if plural}
    <!-- THE SAME CONTROL THE PROPERTY PANEL SHOWS, over the same state. Above the
         groups because it decides WHICH groups they are, exactly as it sits above
         the Inspector's rows for the same reason. Only shown for a plural
         selection: with one item there is no second set to intersect with, so the
         choice would be a control with no effect (inapplicable BY MODE is hidden;
         unavailable by state is what gets shown disabled). -->
    <MultiSelectModeToggle
      {app}
      label="Which tools to show"
      tips={{
        intersection: "Only tools EVERY selected widget has, so a click here reaches all of them. The safe default.",
        union: "Every tool ANY selected widget has. A tool only some of them have still runs — it just applies to the ones that have it, and the row says how many.",
      }}
    />
    <!-- WHAT IS NOT BEING ACTED ON, said out loud — the Property Panel's rule. An
         item that does not exist on this slide has no folded state, so a preset
         write would manufacture a typeless item; core drops it and the pane
         reports it rather than acting on fewer widgets than the user selected. -->
    {#if panel.skipped.length > 0}
      <div class="multi-note">
        Not on this slide, so not being acted on: {panel.skipped.map((id) => app.displayName(id)).join(", ")}
      </div>
    {/if}
    <!-- SHARED-LOOKING BUT NOT SHARED. Two presets with one name that write
         DIFFERENT properties (measured: 19 preset names across the roster do this —
         magnifier and demo_magnify share six), or two widgets opening a section
         under one group id with different titles. The row is still OFFERED (the
         #300 ruling: inform AND allow, never block) and the primary's is the one
         that runs; this names what disagrees. -->
    {#if panel.conflicts.length > 0}
      <div class="multi-note">
        These mean different things on different selected widgets — the first selected widget's version is the one that runs:
        {#each panel.conflicts as c (c.key)}
          <Tooltip text={`These selected widgets disagree about this tool's ${c.aspects.join(", ")}, so running it will not do the same thing to all of them. It is still offered: clicking runs the version this pane is showing, which is the FIRST selected widget's. Nothing stops you; this is the warning, not a refusal.`}
            ><span class="multi-conflict">{c.key}</span></Tooltip>
        {/each}
      </div>
    {/if}
  {/if}
  {#if groups.length === 0}
    <!-- Four honest empty states, not one. The "not on this slide" one exists
         because a SELECTED item that is absent here has nothing to act on (the
         Property Panel's "Not created yet on this slide" case): saying "select a
         widget" there would be a lie about what the user just did. The plural one
         names the escape hatch, because "no tools in common" is exactly when the
         union is what you wanted. -->
    <div class="empty">
      {#if actingCount === 0 && app.selection != null}
        Not on this slide — nothing to act on here.
      {:else if actingCount === 0}
        Select a widget to see its tools.
      {:else if plural}
        No tools in common — switch to All to see every selected widget's tools.
      {:else}
        {primary?.plugin.title ?? primary?.plugin.type} has no tools.
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
          {#each group.rows as entry (entry.key)}
            {@const scope = scopeNote(entry)}
            {#if entry.row.kind === "command"}
              {@const { cmd, disabled, reason, pluralNote } = commandRow(entry)}
              <Tooltip>
                {#snippet tip()}
                  <!-- ABSENT, NOT EMPTY: an entry's `help` is optional, so a row
                       whose command needs none contributes no line here. -->
                  {#if cmd.help}<div>{cmd.help}</div>{/if}
                  <!-- WHAT A PLURAL CLICK DOES — the entry's declared scope, shown
                       only while the selection IS plural, and absent when the entry
                       declares none (a guessed sentence would be a confident lie;
                       see PLURAL_SCOPE). -->
                  {#if pluralNote}<div class="tool-tip-plural">{pluralNote}</div>{/if}
                  {#if scope}<div class="tool-tip-plural">{scope}</div>{/if}
                  <!-- The WHY, beneath the what. Rendered only when the row is
                       actually disabled, so it reads as the live reason rather
                       than a standing caveat. This is also where a tool that
                       refuses a plural selection says so. -->
                  {#if reason}<div class="tool-tip-requires">{unavailableMessage(reason)}</div>{/if}
                  <!-- None of the above: the row's own title is all there is to
                       say, and the button already shows it. Naming it again is the
                       throat-clearing the app's tips were pruned of. -->
                  {#if !cmd.help && !reason && !pluralNote && !scope}<div>{cmd.title}</div>{/if}
                {/snippet}
                <button
                  class="btn tool-action"
                  aria-disabled={disabled}
                  onpointerenter={() => previewRow(entry)}
                  onclick={() => { if (!disabled) runRow(entry); }}
                >
                  <iconify-icon icon={cmd.icon} width="16" height="16"></iconify-icon>
                  <span class="tool-action-label">{cmd.title}</span>
                </button>
              </Tooltip>
            {:else}
              <!-- A preset row: the SAME standard control as a command row (one
                   .btn, one height, one font), plus .tool-preset's preview-tinted
                   hover. Its DESCRIPTION is the hover tip rather than a second
                   line in the row — that is what keeps a whole family on screen in
                   a right-column pane, and it is how the gradient library labels
                   its swatches. A plural selection appends what the click will
                   reach, since a preset is the row kind THIS pane fans out. -->
              <Tooltip>
                {#snippet tip()}
                  <div>{entry.row.preset.description ?? `Apply the ${entry.row.preset.name} preset`}</div>
                  {#if plural}
                    <div class="tool-tip-plural">
                      {scope ?? `Applies to all ${actingCount} selected widgets — one undo unit.`}
                    </div>
                  {/if}
                {/snippet}
                <button
                  class="btn tool-action tool-preset"
                  onpointerenter={() => previewRow(entry)}
                  onclick={() => runRow(entry)}
                >
                  <span class="tool-action-label">{entry.row.preset.name}</span>
                </button>
              </Tooltip>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
