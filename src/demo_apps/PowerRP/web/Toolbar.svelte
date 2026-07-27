<!--
  Toolbar — top bar. Buttons are surfacings of registry commands (same
  entries the palette and shortcuts run), so nothing here has behavior of
  its own. Hover help uses SvelteLib's immediate Tooltip (never native
  title= — manifest rule).

  NOTHING HERE NAMES A COMMAND. Every button's LABEL, ICON, KEYBINDING and
  DISABLED REASON is read from the registries at render time — this file
  declares only WHICH commands appear and in what order. Previously it held a
  `[command id, icon, tooltip]` table, and its own comment admitted the problem:
  "a toolbar tip that disagrees with the palette is the drift the vocabulary pass
  just removed". It had already drifted three times:
      "Copy item (Cmd+C)"  vs registry  "Copy Item"
      "Zoom to fit camera" vs registry  "Zoom to Fit Camera"
      "Show Ghosts"        vs registry  "Toggle Ghost Objects (…)"

  THE STATED BLOCKER WAS FALSE. The tips were hand-written "because several carry
  a keybinding hint the registry title does not" — but core/shortcuts.js
  commandKeys(id) is THE source of truth for bindings and already feeds both the
  HintBar and the palette's key chips. The transcription was also strictly WORSE
  than reading it: five hints were written out by hand while four bindings the
  registry already knew went unmentioned (Put on Top Cmd+Shift+F, Put on Bottom
  Cmd+Shift+B, Present P, Box select B), and Undo/Redo/Copy/Paste were captioned
  Cmd+… where the registry binds Ctrl+… — so the toolbar and the palette showed
  DIFFERENT keys for the same command. The tip is now COMPOSED (registry title +
  registry binding + registry reason), and the chip renders through the same
  KeyCombo component the palette rows use, so one combo is drawn one way app-wide.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import KeyCombo from "../../../lib/KeyCombo.svelte";
  import ShapePicker from "./ShapePicker.svelte";

  let { app } = $props();

  // COMMAND IDS ONLY, grouped as the separators divide them. Title and icon come
  // from app.commands, the binding from app.shortcuts — see the header.
  //
  // SERVER first in the storage group, by user ruling: saving/opening a PROJECT on
  // the server is the common case, and it is the only one that carries the assets.
  // The local-file pair (Export/Import Document as .powerrp.json) and the .zip are
  // still one keystroke away in the command palette — they are the rare path, so
  // they do not earn a permanent button.
  const groups = [
    ["add-rect", "add-circle", "add-text", "add-qrcode", "add-arrow", "add-magnifier", "add-blur", "add-cropbox"],
    ["undo", "redo"],
    ["copy-item", "paste"],
    ["put-on-top", "put-on-bottom"],
    ["save-to-server", "open-project", "clear-doc"],
    ["reset-view", "present"],
  ];

  /**
   * Query. Is the command `id` currently UNAVAILABLE — i.e. does it declare a
   * `when` gate that says no right now? This is the AVAILABILITY axis (transient,
   * per-app-state), the one core/registry.js's TOOL GROUPS block distinguishes
   * from APPLICABILITY: an unavailable button stays rendered and disabled, it is
   * never hidden, because hiding it would make the command unlearnable.
   */
  function unavailable(id) {
    const cmd = app.commands.get(id);
    return !!cmd.when && !cmd.when(app);
  }

  /**
   * Query. WHY the command `id` cannot run right now, or null when it can run (or
   * when its entry does not declare a reason yet). Same expression, same
   * precedence and the same "Unavailable — requires …" sentence the Tools pane
   * uses, so a disabled control explains itself identically wherever it appears.
   *
   * `requires` is the command entry's own field, so it is read here rather than
   * restated: this file must not know why Copy needs a selection.
   */
  function unavailableReason(id) {
    return unavailable(id) ? (app.commands.get(id).requires ?? null) : null;
  }
</script>

<!-- THE ONE command-tip body. Every button in this file renders THIS, so there is
     a single place that reads the registries and a single tip layout.
     `note` is the clause the registry title genuinely does not carry (e.g. what
     snapping snaps to) — the TOOL_POOL `help` idea (core/registry.js): extra
     explanation declared beside the id, never a restatement of the title. -->
{#snippet commandTip(id, note = null)}
  {@const keys = app.shortcuts.commandKeys(id)}
  {@const reason = unavailableReason(id)}
  <div class="cmd-tip-head">
    <span>{app.commands.get(id).title}</span>
    {#if keys}<span class="cmd-tip-keys"><KeyCombo {keys} /></span>{/if}
  </div>
  {#if note}<div class="cmd-tip-note">{note}</div>{/if}
  <!-- The WHY, beneath the what — rendered only while the button is actually
       disabled, so it reads as the live reason and not a standing caveat (the
       Tools pane's rule, and its class). -->
  {#if reason}<div class="tool-tip-requires">Unavailable — requires {reason}</div>{/if}
{/snippet}

<div class="toolbar">
  <!-- The presentation TITLE. Double-click (or Enter/F2 when focused) opens the
       Rename modal, which writes doc.meta.name — the one name model shared with
       Save and Open. role/tabindex/onkeydown keep the double-click affordance
       keyboard-accessible (it is the sole in-place rename trigger). -->
  <Tooltip text="Double-click to rename">
    <span
      class="doc-name"
      role="button"
      tabindex="0"
      ondblclick={() => app.renamePresentation()}
      onkeydown={(e) => { if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); app.renamePresentation(); } }}
    >{app.doc.meta.name}</span>
  </Tooltip>
  {#each groups as group, gi}
    {#if gi > 0}<span class="sep"></span>{/if}
    {#each group as id}
      <!-- Disabled state comes from the command's own `when` (grayed out when it
           can't run — e.g. Copy with nothing selected), and the tip says WHY. -->
      <Tooltip>
        {#snippet tip()}{@render commandTip(id)}{/snippet}
        <button
          class="btn-icon"
          aria-label={app.commands.get(id).title}
          disabled={unavailable(id)}
          onclick={() => app.runCommand(id)}
        >
          <iconify-icon icon={app.commands.get(id).icon} width="18" height="18"></iconify-icon>
        </button>
      </Tooltip>
    {/each}
    <!-- The visual Shape-grid picker rides at the end of the INSERT group (the
         Add buttons), beside Add Rectangle — another surfacing of the shape
         plugin's placement, but a grid instead of a single command. -->
    {#if gi === 0}<ShapePicker {app} />{/if}
  {/each}
  <span class="sep"></span>
  <!-- BOX SELECT (manifest Round 12B "Box select round 2": "A TOOLBAR BUTTON
       for default box select"). Arms the band CROSSHAIR at the default
       bandMode ("regular" — same resolution the palette's "Regular" entry
       and an empty-space drag both use); "active" (the toggle-button
       convention below) while armed OR while a band drag is actually live,
       so the button visibly reflects the mode it started, like the snap/
       anchor/ghost toggles beside it. A left click while armed is consumed
       by CanvasView's pointer-down (starts the drag), not this button. -->
  <Tooltip>
    {#snippet tip()}{@render commandTip("band-select-regular", "Drag a box to select; hold Shift to deselect instead.")}{/snippet}
    <button
      class="btn-icon"
      class:active={app.crosshair?.kind === "band" || app.dragKind === "band"}
      aria-label={app.commands.get("band-select-regular").title}
      aria-pressed={app.crosshair?.kind === "band"}
      onclick={() => app.runCommand("band-select-regular")}
    >
      <iconify-icon icon={app.commands.get("band-select-regular").icon} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <!-- Snap toggles: ACTIVE (accent) when the setting is on; while a snap is
       actually ENGAGED mid-drag the icon takes the guide color (snap-engaged). -->
  <Tooltip>
    {#snippet tip()}{@render commandTip("toggle-snap", "Guides appear while moving or resizing.")}{/snippet}
    <button
      class="btn-icon"
      class:active={app.snapEnabled}
      class:snap-engaged={app.snapEngaged}
      aria-label={app.commands.get("toggle-snap").title}
      aria-pressed={app.snapEnabled}
      onclick={() => app.runCommand("toggle-snap")}
    >
      <iconify-icon icon={app.commands.get("toggle-snap").icon} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip>
    {#snippet tip()}{@render commandTip("toggle-snap-size", "Dimension indicators appear when a size matches another widget's.")}{/snippet}
    <button
      class="btn-icon"
      class:active={app.snapSizeEnabled}
      class:snap-engaged={app.snapEngaged}
      aria-label={app.commands.get("toggle-snap-size").title}
      aria-pressed={app.snapSizeEnabled}
      onclick={() => app.runCommand("toggle-snap-size")}
    >
      <iconify-icon icon={app.commands.get("toggle-snap-size").icon} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip>
    {#snippet tip()}{@render commandTip("toggle-anchors", "Anchors are the endpoint binding targets an arrow can attach to.")}{/snippet}
    <button
      class="btn-icon"
      class:active={app.anchorsVisible}
      aria-label={app.commands.get("toggle-anchors").title}
      aria-pressed={app.anchorsVisible}
      onclick={() => app.runCommand("toggle-anchors")}
    >
      <!-- User-specified composite (round-11 correction: NOT a literal
           anchor glyph — the X-cross that anchors render as on canvas,
           CENTERED in the magnet; iconify-only rule, stacked mdi glyphs).
           ONE OF THE THREE DELIBERATE ICON OVERRIDES in this file, with Show
           Ghosts below (the other composite) and light/dark at the end (a
           state-dependent glyph): all three are things the registry's single
           `icon` string cannot express, so those buttons draw their own glyphs
           while still taking their LABEL from the registry. -->
      <span class="icon-stack">
        <iconify-icon icon="mdi:magnet" width="18" height="18"></iconify-icon>
        <iconify-icon class="icon-stack-overlay" icon="mdi:close" width="9" height="9"></iconify-icon>
      </span>
    </button>
  </Tooltip>
  <Tooltip>
    {#snippet tip()}{@render commandTip("toggle-ghosts")}{/snippet}
    <button
      class="btn-icon"
      class:active={app.showGhosts}
      aria-label={app.commands.get("toggle-ghosts").title}
      aria-pressed={app.showGhosts}
      onclick={() => app.runCommand("toggle-ghosts")}
    >
      <!-- Composed eye + dashed-box (manifest ARCHITECTURE PLAN #2: "icon =
           composed eye + dashed-box mdi, the magnet+anchor composition
           precedent" — iconify-only rule, stacked mdi glyphs like the
           anchor toggle above; the second of the three icon overrides). -->
      <span class="icon-stack">
        <iconify-icon icon="mdi:square-outline" width="18" height="18"></iconify-icon>
        <iconify-icon class="icon-stack-overlay" icon="mdi:eye-outline" width="11" height="11"></iconify-icon>
      </span>
    </button>
  </Tooltip>
  <span class="spacer"></span>
  <!-- LIGHT/DARK. Used to be the one button with no registry entry — so the one
       button that could never take a keybinding or appear in the palette, with its
       label and tip written out by hand. It now runs `toggle-light-dark` like every
       other button here, and its label, tip and disabled reason come from the
       registry. Only the GLYPH is local: it names the theme the click would switch
       TO, which the registry's single `icon` string cannot express — the THIRD (and
       last) deliberate icon override in this file, same standing as the anchor and
       ghost composites above. `active` is not used: neither theme is the "on"
       state, and the glyph already says which way the flip goes.
       No arrow glyph in the wording ("›" is in the manifest's banned set). -->
  <Tooltip>
    {#snippet tip()}{@render commandTip("toggle-light-dark", 'Every theme, not just these two: palette, "Color Theme".')}{/snippet}
    <button
      class="btn-icon"
      aria-label={app.commands.get("toggle-light-dark").title}
      onclick={() => app.runCommand("toggle-light-dark")}
    >
      <iconify-icon icon={app.theme === "light" ? "mdi:weather-night" : "mdi:weather-sunny"} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <Tooltip>
    {#snippet tip()}{@render commandTip("toggle-palette")}{/snippet}
    <button
      class="btn-icon"
      aria-label={app.commands.get("toggle-palette").title}
      onclick={() => app.runCommand("toggle-palette")}
    >
      <iconify-icon icon={app.commands.get("toggle-palette").icon} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
</div>
