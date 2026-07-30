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
  import { commandUnavailable, commandUnavailableReason } from "../core/commands.js";

  // `renderBadge` is the count of renders still working plus finished ones not
  // yet seen (App.svelte polls it; renderJobView.renderBadgeCount defines it).
  // It is passed IN rather than fetched here because the toolbar must not own a
  // network poll, and because the badge has to keep counting while this
  // component is not the thing anyone is looking at.
  let { app, renderBadge = 0 } = $props();

  // COMMAND IDS ONLY, grouped as the separators divide them. Title and icon come
  // from app.commands, the binding from app.shortcuts — see the header.
  //
  // SERVER first in the storage group, by user ruling: saving/opening a PROJECT on
  // the server is the common case, and it is the only one that carries the assets.
  // The local-file pair (Export/Import Document as .powerrp.json) and the .zip are
  // still one keystroke away in the command palette — they are the rare path, so
  // they do not earn a permanent button.
  // CROP BOX and BLUR LAYER were dropped from the insert row by user ruling: they
  // belong in the command palette, not in permanent toolbar space. They are still
  // one keystroke away as add-cropbox / add-blur, and neither command changed —
  // only its claim to a button. RENDER CENTER earns one for the opposite reason:
  // its badge has to be visible while its dialog is shut.
  //
  // (Entries here must stay BARE COMMAND IDS — tests/toolbar_surfacing_test.js
  // parses this literal to prove nothing hardcodes a title or icon, so a quoted
  // phrase inside the array reads to it as a malformed id.)
  const groups = [
    ["add-rect", "add-circle", "add-text", "add-qrcode", "add-arrow", "add-magnifier"],
    ["undo", "redo"],
    ["copy-item", "paste"],
    ["put-on-top", "put-on-bottom"],
    ["save-to-server", "open-project", "clear-doc"],
    ["render-center"],
    ["reset-view", "present"],
  ];

  /**
   * Pure function. The hover sentence for a save state — the ONE place each of
   * the three cases is put into words.
   *
   * "Saved" carries the TIME when there is one, because "saved" alone answers a
   * narrower question than the user asked: after a long editing session the
   * useful fact is not that a save happened but when. A never-saved document has
   * no time to report and says so plainly rather than inventing one.
   *
   * @param {"saving"|"saved"|"unsaved"} state From app.saveState()
   * @param {number|null} at Epoch ms of the last successful save, or null
   * @returns {string}
   *
   * @example saveText("saving", null)
   * 'Saving…'
   * @example saveText("unsaved", null)
   * 'Unsaved changes — not yet saved to the server'
   * @example // saved, with a time — e.g. "Saved to server at 14:32:05"
   * saveText("saved", 1750000000000).startsWith("Saved to server at ")
   * true
   */
  function saveText(state, at) {
    if (state === "saving") return "Saving…";
    if (state === "unsaved") return "Unsaved changes — not yet saved to the server";
    return at ? `Saved to server at ${new Date(at).toLocaleTimeString()}` : "Saved to server";
  }

  // The indicator's state and its sentence, derived together from ONE read of
  // app.saveState() so the dot and the hover text can never describe different
  // states (see the markup's note).
  let saveIndicator = $derived.by(() => {
    const state = app.saveState();
    return { state, text: saveText(state, app.lastSavedAt) };
  });

  /**
   * Query. Is the command `id` currently UNAVAILABLE — i.e. does it declare a
   * `when` gate that says no right now? This is the AVAILABILITY axis (transient,
   * per-app-state), the one core/registry.js's TOOL GROUPS block distinguishes
   * from APPLICABILITY: an unavailable button stays rendered and disabled, it is
   * never hidden, because hiding it would make the command unlearnable.
   *
   * The predicate itself lives in core/commands.js — the Toolbar, the Tools pane
   * and the palette all ask it, and three copies of "does this gate say no" are
   * three chances to disagree about what disabled means. These wrappers are the
   * id → entry lookup this file needs, nothing more.
   */
  function unavailable(id) {
    return commandUnavailable(app.commands.get(id), app);
  }

  /**
   * Query. WHY the command `id` cannot run right now, or null when it can run (or
   * when its entry does not declare a reason yet). Same expression, same
   * precedence and the same "Unavailable — requires …" sentence the Tools pane
   * and the palette's help section use, so a disabled control explains itself
   * identically wherever it appears.
   *
   * `requires` is the command entry's own field, so it is read there rather than
   * restated: this file must not know why Copy needs a selection.
   */
  function unavailableReason(id) {
    return commandUnavailableReason(app.commands.get(id), app);
  }

  /**
   * Query. The notification-badge count for a toolbar command, or 0 for none.
   * A lookup rather than an `id ===` test in the markup so a second badged
   * command is a line here, not a template edit.
   */
  function badgeFor(id) {
    return id === "render-center" ? renderBadge : 0;
  }

  // THE SHELL SEAM. True only inside the Electron desktop shell, where "open this
  // in a web browser" is a meaningful action; in a plain browser you are already
  // there, so the globe button does not render at all.
  //
  // WHY THE USER AGENT and not something cleaner: the shell runs with
  // contextIsolation and NO preload script, so there is no bridge object to test
  // for — `window.require`, `process.versions.electron` and an injected
  // `window.powerrp` are all absent by design. Electron still stamps "Electron/…"
  // into navigator.userAgent, which makes the UA the only seam that exists here.
  // Read ONCE at module init rather than per render: a user agent cannot change
  // over a page's life, and re-testing it every reactive pass would imply it can.
  const IN_ELECTRON_SHELL = navigator.userAgent.includes("Electron");

  // THE URL THE TIP REPORTS. `location.href` is not reactive — nothing re-renders
  // when the app pushes a new history entry (opening a project rewrites the query
  // string), so a $derived over it would show whatever the URL was when this
  // component last happened to re-render. Mirroring it in state and refreshing on
  // the events that can change it keeps the tip honest about the CURRENT page,
  // which is the whole point of a tooltip that claims to tell you the URL.
  //
  // Only mounted in the shell (IN_ELECTRON_SHELL below); in a browser the listener
  // would run for a button that does not exist.
  let pageUrl = $state(location.href);
  /** Command. Refreshes the mirrored URL from the address bar. Mutates pageUrl. */
  function syncPageUrl() {
    pageUrl = location.href;
  }
  $effect(() => {
    if (!IN_ELECTRON_SHELL) return;
    // popstate covers back/forward; hashchange covers fragment-only edits, which
    // popstate does not always report. NEITHER fires for the app's own
    // history.pushState — nothing does — so the button ALSO syncs on pointerenter
    // (see the markup), which is the moment before the tip can be read. Between
    // them there is no path to a stale tip that a user could actually observe.
    window.addEventListener("popstate", syncPageUrl);
    window.addEventListener("hashchange", syncPageUrl);
    return () => {
      window.removeEventListener("popstate", syncPageUrl);
      window.removeEventListener("hashchange", syncPageUrl);
    };
  });

  /**
   * Command. Hops the current page out of the desktop shell and into the system
   * browser: the shell's setWindowOpenHandler (desktop/main.js) catches
   * window.open and hands the URL to shell.openExternal, denying the in-app
   * window. Not rendered in a plain browser, so there is no case where this
   * merely opens a duplicate tab of the page you are already looking at.
   *
   * Reads location.href live rather than the mirrored `pageUrl`: the click must
   * open what the address bar says NOW, even if a pushState landed between the
   * last sync and the click.
   */
  function openInBrowser() {
    window.open(location.href);
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
  <!-- THE SAVE INDICATOR, verbatim: "there's no indicator on the top left on
       whether or not it's been saved to the server. There should be an indicator
       on the top left, maybe an empty circle, a filled circle or something,
       which when I hover over it tells me whether or not it's saved."

       A circle, exactly as asked: FILLED = saved to the server, EMPTY (ring
       only) = unsaved changes, HALF = a save in flight. The state and the
       sentence come from ONE place (saveIndicator below, off app.saveState()),
       so the dot and its hover text cannot disagree — the failure mode for a
       status light is showing green while saying something else.

       It is NOT a button: saving is Cmd+S / the Save command, and a control that
       looks clickable but only reports would be a lie about its own affordance.
       It is still focusable (tabindex) because the information is otherwise
       pointer-only, and Tooltip anchors to the element on keyboard focus. -->
  <Tooltip text={saveIndicator.text}>
    <span
      class="save-indicator {saveIndicator.state}"
      data-state={saveIndicator.state}
      role="status"
      tabindex="0"
      aria-label={saveIndicator.text}
    ></span>
  </Tooltip>
  <!-- The presentation TITLE. SINGLE-click (or Enter/F2 when focused) opens the
       Rename modal, which writes doc.meta.name — the one name model shared with
       Save and Open. role/tabindex/onkeydown keep the affordance keyboard-
       accessible (it is the sole in-place rename trigger).

       SINGLE-CLICK, on the user's question: "why does the name have to be
       double-click to rename? Why not single-click?" There is no competing
       gesture on this element to protect — the title is not selectable, not
       draggable and not a drop target, so the second click was pure ceremony. It
       is `onclick`, not a rename-on-focus, so tabbing THROUGH the toolbar does not
       pop a modal.

       SLIDES KEEP DOUBLE-CLICK (SlideNav) — reaffirmed by the user, and the
       distinction has a reason: a slide card's single click SELECTS it, so rename
       there must be the second gesture or it would fight navigation. This title
       has no first gesture to lose. -->
  <Tooltip text="Click to rename">
    <span
      class="doc-name"
      data-hint-scope="titleRename"
      role="button"
      tabindex="0"
      onclick={() => app.renamePresentation()}
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
          aria-label={badgeFor(id) ? `${app.commands.get(id).title} — ${badgeFor(id)} active or unseen` : app.commands.get(id).title}
          disabled={unavailable(id)}
          onclick={() => app.runCommand(id)}
        >
          <iconify-icon icon={app.commands.get(id).icon} width="18" height="18"></iconify-icon>
          <!-- NOTIFICATION BADGE. Only the Render Center has one today, but it
               hangs off a general per-id lookup rather than an `id ===` test in
               the markup, so the next command that needs one declares it beside
               the others instead of editing this template. The count is also
               folded into aria-label — a coloured dot is not an announcement. -->
          {#if badgeFor(id)}
            <span class="btn-badge">{badgeFor(id)}</span>
          {/if}
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
  <!-- THE PROJECT SCRIPT, verbatim: "a global script per project… on the top right
       as an icon with a script icon, which would actually be a repository of
       functions written in JavaScript that can then be used in different
       properties… complex code can be reused in many places."

       Top right, where it was asked for, and FIRST in that cluster — it is the only
       button there that edits the DOCUMENT (the globe, the theme and the palette
       beside it act on the app or the window), so it sits nearest the document side
       of the bar rather than being buried among the app-level controls.

       Composed tip like every other button here (registry title + binding +
       reason): the "immediate tooltip" the ruling asks for is the Tooltip
       component's own behaviour, which is the app-wide default — a native title=
       is banned. The note is the clause the command title cannot carry, and it is
       the one thing a first-time reader needs: WHERE the functions come out. -->
  <Tooltip>
    {#snippet tip()}{@render commandTip("edit-project-script", "Functions and values you assign to `exports` become callable from any property equation in this project.")}{/snippet}
    <button
      class="btn-icon"
      aria-label={app.commands.get("edit-project-script").title}
      onclick={() => app.runCommand("edit-project-script")}
    >
      <iconify-icon icon={app.commands.get("edit-project-script").icon} width="18" height="18"></iconify-icon>
    </button>
  </Tooltip>
  <!-- OPEN IN A WEB BROWSER, verbatim: "another button on the top right of the
       screen that has a global icon, a web icon, that when I hover over it, an
       immediate tooltip tells me what the URL is, and when I click it, opens the
       current thing inside a web browser."

       DESKTOP SHELL ONLY (IN_ELECTRON_SHELL — see the UA note in the script). In a
       plain browser the button would offer to open the page you are already on,
       which is why it is absent there rather than merely disabled: an unavailable
       command stays visible so it can be learned (core/registry.js TOOL GROUPS),
       but this one is not unavailable — outside the shell it does not exist.

       THE TIP IS THE URL ITSELF, which is what was asked for, so it is the one
       button here whose tip is NOT composed from the registry: there is no command
       to read a title from, and the useful text is live page state. `.cmd-tip-url`
       wraps it — a URL with a long project name is the one tip that can outgrow
       the tooltip's max-width, and breaking it mid-path beats clipping it.

       NOT a registry command, deliberately: it would be the only palette entry
       that silently does nothing for every user not in the desktop shell. -->
  {#if IN_ELECTRON_SHELL}
    <Tooltip>
      {#snippet tip()}
        <div class="cmd-tip-head"><span>Open in a web browser</span></div>
        <div class="cmd-tip-url">{pageUrl}</div>
      {/snippet}
      <button
        class="btn-icon"
        aria-label={`Open in a web browser: ${pageUrl}`}
        onpointerenter={syncPageUrl}
        onfocus={syncPageUrl}
        onclick={openInBrowser}
      >
        <iconify-icon icon="mdi:web" width="18" height="18"></iconify-icon>
      </button>
    </Tooltip>
  {/if}
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
