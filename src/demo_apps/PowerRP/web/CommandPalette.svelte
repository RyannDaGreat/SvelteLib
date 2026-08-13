<!--
  CommandPalette — Cmd+Shift+P, center-top, fuzzy search over the command
  registry (core/commands.js). Supports SUBMENUS: a command with `children`
  drills down (breadcrumb shown above the input; Backspace on an empty query
  or Esc goes back up; Esc at the root closes). The palette is a pure
  SURFACING of commands: shortcuts, toolbar buttons, and future context menus
  run the same entries.

  IT ALSO HAS A SECOND STAGE (R7-42): a command whose action needs ONE
  per-document argument sets app.palettePicker and the palette turns into a
  searchable list of that argument's candidate values. The values are NOT
  commands — they never enter the registry — which is the whole point: the
  minted per-widget-type rows this replaced were searchable top-level hits, so
  typing "add" surfaced "PowerPoint Shape (1) — Select by Widget Type". See the
  picker-stage block in the script for the ruling and the design.

  UNAVAILABLE COMMANDS ARE GREYED, NOT DROPPED. A `when` gate that says no is the
  AVAILABILITY axis (core/registry.js's TOOL GROUPS block names the two axes;
  core/commands.js's header carries the ruling), and the Toolbar and the Tools
  pane have always rendered it as a disabled control that explains itself. The
  palette was the last surfacing that filtered the entry out instead, so a
  command you could not run was a command you could not FIND — the user's report
  ("I'm seeing Respace Filmstrip Frames even though I'm not selecting a
  filmstrip … it could be grayed out, and even just that some tooltip tells us
  why it's grayed out") is both halves of that one defect.

  THEY ALSO SINK. Second user ruling: "ones that we can select are always going to
  get priority and be sorted above ones that are not. It's a stable sort." So the
  ranked list is PARTITIONED here into available-then-unavailable, and stably: the
  relative order search() produced survives inside each half, because the split is
  two buckets filled in one forward pass rather than a comparator. Availability
  therefore outranks the fuzzy/MRU rank, but only at that one coarse level, and it
  still changes no membership — nothing is hidden, which was the point.

  THE BOTTOM SECTION is the tooltip that ruling asks for, and it carries the
  optional `help` too. It is ABSENT (not empty) when the highlighted entry has
  neither — an always-present box that is usually blank is the dead chrome the
  Tools pane's "an empty group cannot reach here" rule exists to prevent. It
  follows `highlighted`, so hover AND the arrow keys drive it through the ONE
  hover path the preview protocol already established (a second hover mechanism
  would be free to disagree with the first about which row is current), and a
  keyboard-only user gets help a pointer tooltip could never show them.
-->
<script>
  import "iconify-icon";
  import KeyCombo from "../../../lib/KeyCombo.svelte";
  import { rpFuzzyMatchIndices, rpFuzzyRank } from "../core/fuzzy.js";
  import { commandUnavailable, commandUnavailableReason, partitionByAvailability, unavailableMessage } from "../core/commands.js";

  let { app } = $props();

  /**
   * Pure function. Splits `title` into consecutive runs by whether each code
   * point is a fuzzy match (per rpFuzzyMatchIndices for `query`) — for wrapping
   * matched chars in <mark>. Empty/non-matching query → one unhit run of the
   * whole title. Iterates Array.from(title) so indices align with the walk.
   *
   * @example titleSegments("Distribute Horizontally", "dh")
   *   // [{text:"D",hit:true},{text:"istribute ",hit:false},
   *   //  {text:"H",hit:true},{text:"orizontally",hit:false}]
   * @example titleSegments("Group", "") // [{text:"Group",hit:false}]
   */
  function titleSegments(title, query) {
    const indices = query ? rpFuzzyMatchIndices(query, title) : null;
    if (!indices || !indices.length) return [{ text: title, hit: false }];
    const hit = new Set(indices);
    const chars = Array.from(title);
    const runs = [];
    for (let i = 0; i < chars.length; i += 1) {
      const isHit = hit.has(i);
      const last = runs[runs.length - 1];
      if (last && last.hit === isHit) last.text += chars[i];
      else runs.push({ text: chars[i], hit: isHit });
    }
    return runs;
  }

  let query = $state("");
  let highlighted = $state(0);
  let stack = $state([]); // drill-down path of submenu entries
  let inputEl = $state(null);
  let resultsEl = $state(null); // the scrollable results list

  // ── THE PICKER STAGE (R7-42) ───────────────────────────────────────────────
  // A command whose action needs ONE per-document argument sets app.palettePicker
  // (see app.svelte.js openTypePicker) instead of minting a command per candidate
  // value. This palette then shows that picker OVER ITS OWN ROW SURFACE — the
  // same rows, the same fuzzy highlighting, the same arrow/Enter keys, the same
  // breadcrumb-and-Backspace way back — rather than opening a second window.
  //
  // WHY A STAGE AND NOT A SUBMENU: a submenu's options are CHILD COMMAND ENTRIES,
  // and since R7-18 a top-level query pools one level of children beside their
  // parents, so every option was a searchable top-level row. That is exactly what
  // the user reported ("PowerPoint Shape (1) — Select by Widget Type" surfacing
  // under the search "add"): the palette holds ACTIONS, and a per-document
  // parameter is not one. Picker options are NOT commands — they never enter the
  // registry, so they can never be a top-level hit, and the roster is static.
  //
  // WHY IT REUSES THIS COMPONENT rather than a lib/ dropdown: the flow it has to
  // preserve is the PALETTE's — open, type, arrow, Enter, all without the mouse
  // and without focus leaving the one input. Handing the second step to another
  // surface would mean a second focus model and a second set of keys.
  // Ranked by the SAME fuzzy module the command rows use (rpFuzzyRank is its
  // filter-and-sort helper; an empty query keeps the incoming order, which for
  // typesOnSlide() is alphabetical by title).
  let pickerOptions = $derived(rpFuzzyRank(app.palettePicker?.options ?? [], query, (o) => o.label));

  /** Command. Leaves the picker stage without picking, restoring the command
   *  list. Reverting the live preview is the shared teardown below. */
  function closePicker() {
    revertPreview();
    app.palettePicker = null;
    query = "";
    resetHighlight();
    inputEl?.focus();
  }

  /** Command. Commits the highlighted option: the pending preview is DROPPED
   *  without being called (its staged change stays, exactly as activate() does
   *  for a previewable command), `onPick` makes it durable, and the palette
   *  closes. */
  function pick(option) {
    previewRevert = null;
    previewedId = null;
    const spec = app.palettePicker;
    app.palettePicker = null;
    app.paletteOpen = false;
    spec.onPick(app, option.value);
  }

  let parent = $derived(stack.length ? stack[stack.length - 1] : null);
  // `used` inside the registry is a plain (non-reactive) Map, so markUsed() from
  // runCommand can't dirty this derived. Read app.paletteOpen (flips on every
  // open) so the empty-query MRU order is recomputed fresh each time the palette
  // is shown — even when query/stack are unchanged from the prior open.
  // While the picker stage is up the command search does not run at all: the two
  // stages are exclusive, and a palette showing a picker must not be evaluating
  // every command's `when` underneath it.
  let picking = $derived(!!app.palettePicker);
  let results = $derived(app.paletteOpen && !picking ? app.commands.search(query, parent) : []);

  // AVAILABLE FIRST, then unavailable — user ruling. The partition runs HERE and
  // not in search() because availability is a property of the surfacing, not of
  // the ranking: search() stays app-free and any caller that just wants the fuzzy
  // rank still gets it unreordered. One pass answers both questions the rows need
  // (where each goes, and which are grey), so no gate is evaluated twice.
  //
  // The list DOES re-partition when the selection changes with the palette open —
  // rows can move under a stationary cursor. That is inherent to the ruling and
  // preferred to the alternative it replaced: a runnable command ranked below a
  // dead one. Inside each half the MRU / fuzzy order is exactly as search() left
  // it, so the relative order of the commands you can actually run never moves.
  let split = $derived(partitionByAvailability(results, app));
  let rows = $derived([...split.available, ...split.unavailable]);
  let unavailableIds = $derived(new Set(split.unavailable.map((c) => c.id)));

  // The HIGHLIGHTED entry drives both the bottom section and the live preview —
  // one notion of "the current row", so they can never point at different ones.
  // Indexed into the RENDERED order, which is the only order the user can see.
  // In the picker stage the rendered rows are the picker's options, so the SAME
  // index drives them and the arrow keys, the scroll-follow and the preview
  // effect all compose with no second mechanism.
  let current = $derived(picking ? (pickerOptions[highlighted] ?? null) : (rows[highlighted] ?? null));
  let rowCount = $derived(picking ? pickerOptions.length : rows.length);
  // A picker option is never "unavailable" (it is offered because it exists on
  // this slide), and it carries no `help`, so both bottom-section inputs are null
  // there rather than asking a command question of a non-command.
  let currentReason = $derived(!picking && current ? commandUnavailableReason(current, app) : null);
  let currentHelp = $derived(picking ? null : (current?.help ?? null));

  /** Command. Resets the highlight to the first row AND snaps the list back
   * to the top — the two must move together: open, typing, submenu drill,
   * and back-up all restart the list, and a stale scroll offset would leave
   * row 0 highlighted but out of view. */
  function resetHighlight() {
    highlighted = 0;
    if (resultsEl) resultsEl.scrollTop = 0;
  }

  /** Command. Keeps the KEYBOARD-highlighted row visible. Called ONLY from
   * the arrow-key branches — row hover (pointermove) also moves `highlighted`,
   * but hover must never yank the scroll position. scrollIntoView follows Dropdown's
   * scrollTargetIntoView precedent (src/lib/Dropdown.svelte); it centers on
   * OPEN, whereas per-keystroke stepping wants {block: "nearest"} so the list
   * moves only when the row would leave view. Safe pre-flush: the row
   * elements already exist — arrows just move the highlight among them. */
  function scrollHighlightedIntoView() {
    resultsEl?.querySelectorAll(".palette-item")[highlighted]?.scrollIntoView({ block: "nearest" });
  }

  // ── Scroll-follows-cursor (GENERAL protocol, not special-cased to preview) ──
  // Browsers fire NO pointermove while content scrolls under a stationary
  // cursor, so `highlighted` (set by pointermove above) goes stale the moment
  // the list scrolls without the mouse moving — the user's report ("what's
  // under my cursor should update... instead of having to move my mouse every
  // time"). Fix: remember the last real pointer position over the list, and on
  // scroll re-derive the row under that point via elementFromPoint, setting
  // `highlighted` through the exact same variable a real hover would — so the
  // preview effect above (which only watches `current`/`highlighted`) composes
  // for free: a previewable row scrolling under the cursor previews, same as
  // if the mouse had moved to it.
  //
  // THE SUBTLETY: arrow keys scroll the list PROGRAMMATICALLY
  // (scrollHighlightedIntoView -> scrollIntoView), and that scroll must NOT
  // let the stationary mouse steal the highlight back — otherwise arrowing
  // past the cursor's row would snap highlight back to the mouse mid-keypress.
  // So we only re-hit-test after a scroll we can attribute to the USER: wheel
  // or touchmove on the list stamps `lastUserScrollAt`, and the scroll handler
  // only acts within a short window after that stamp. A programmatic
  // scrollIntoView fires the scroll event too, but with no recent wheel/touch
  // to justify it, so it is ignored.
  let pointerX = null; // last known real pointer position over the list, or null
  let pointerY = null;
  let lastUserScrollAt = -Infinity; // timestamp of the last wheel/touchmove on the list
  const USER_SCROLL_WINDOW_MS = 150; // generous over one scroll-animation frame, tight enough that an unrelated later scroll can't misattribute

  function notePointer(e) {
    pointerX = e.clientX;
    pointerY = e.clientY;
  }

  function noteUserScroll() {
    lastUserScrollAt = performance.now();
  }

  function pointerInsideList() {
    if (pointerX === null || !resultsEl) return false;
    const r = resultsEl.getBoundingClientRect();
    return pointerX >= r.left && pointerX <= r.right && pointerY >= r.top && pointerY <= r.bottom;
  }

  /** Re-hit-tests the row under the last known pointer position and, if it
   * differs from the current highlight, adopts it — exactly what a real hover
   * would have done, had the browser fired one. No-ops when the scroll wasn't
   * user-driven (see USER_SCROLL_WINDOW_MS) or the pointer isn't over the list,
   * so a keyboard-driven scrollIntoView never steals highlight from the arrow
   * keys. */
  function followPointerAfterScroll() {
    if (performance.now() - lastUserScrollAt > USER_SCROLL_WINDOW_MS) return;
    if (!pointerInsideList()) return;
    const el = document.elementFromPoint(pointerX, pointerY)?.closest(".palette-item");
    if (!el) return;
    // data-command-id carries the row's identity in EITHER stage: a command's id,
    // or a picker option's value. The rendered rows are the only list either
    // lookup consults, so they cannot disagree about which row is under the point.
    const id = el.dataset.commandId;
    const i = picking ? pickerOptions.findIndex((o) => o.value === id) : rows.findIndex((c) => c.id === id);
    if (i >= 0 && i !== highlighted) highlighted = i;
  }

  $effect(() => {
    if (app.paletteOpen && inputEl) {
      query = "";
      stack = [];
      resetHighlight();
      inputEl.focus();
    }
  });

  // A CLOSED PALETTE HOLDS NO PICKER. Escape at the picker stage goes BACK to the
  // commands (see back()), but the backdrop click and every other close path set
  // paletteOpen directly — and a picker left behind would be the stage the palette
  // opened onto next time, for a command the author has since forgotten running.
  // The live preview is reverted with it, which is the same teardown the command
  // stage gets when `results` empties on close.
  $effect(() => {
    if (!app.paletteOpen && app.palettePicker) {
      revertPreview();
      app.palettePicker = null;
    }
  });

  // ── Previewable commands (GENERAL protocol) ────────────────────────────────
  // A command entry MAY declare `preview(app) -> revert`: a TEMPORARY, non-
  // committing application of its effect, returning a closure that undoes it.
  // The palette previews whichever entry is HIGHLIGHTED — hover (pointermove)
  // and the arrow keys both drive `highlighted`, so ONE effect covers both the
  // "hovered" and "arrow-focused" triggers. When the highlight moves to a
  // different entry, or the palette closes without selecting (results empties),
  // the active preview is reverted. Selecting an entry (activate → Enter/click)
  // COMMITS: the pending revert is dropped WITHOUT being called (so the
  // previewed change stays) and the entry's `run` makes it durable. Commands
  // with no `preview` are unaffected. Theme entries are the first adopters
  // (app.previewTheme — a non-persisted viewer-preference swap; the committing
  // `run` = app.setTheme persists). Any future command opts in the same way.
  //
  // THE PICKER STAGE USES THE SAME PROTOCOL, one level down: its spec may declare
  // `onPreview(app, value) -> revert`, and an option's `value` plays the part the
  // command's `id` plays — one highlight, one preview, one revert, whichever
  // stage is up. That is why the by-type rows kept their hover preview across
  // this change with no second mechanism.
  //
  // previewRevert/previewedId are PLAIN (non-$state) bridge variables: the
  // effect reads/writes them imperatively but must NOT react to them — only
  // `current` (i.e. `highlighted` and `rows`) may drive it.
  let previewRevert = null; // closure that undoes the active preview, or null
  let previewedId = null; // id (or picker option value) currently previewed, or null

  /** Command. Rolls back the live preview, if any, and forgets it. */
  function revertPreview() {
    if (previewRevert) previewRevert();
    previewRevert = null;
    previewedId = null;
  }

  $effect(() => {
    const row = current;
    const spec = app.palettePicker;
    const id = (spec ? row?.value : row?.id) ?? null;
    if (id === previewedId) return; // same entry still highlighted — nothing to do
    if (previewRevert) previewRevert(); // roll back the previous preview
    // An UNAVAILABLE command previews nothing: its `when` says the write it would
    // stage cannot be derived (bind-to-camera with nothing selected computes an
    // empty pair list), so previewing it would show an empty change and call a
    // revert for it. The Tools pane's previewRow makes the same exclusion. A
    // picker option has no gate — it is offered because it is there.
    previewRevert = spec
      ? (row && spec.onPreview ? spec.onPreview(app, row.value) : null)
      : (row?.preview && !commandUnavailable(row, app) ? row.preview(app) : null);
    previewedId = id;
  });

  function activate(cmd) {
    // A GREYED ROW IS INERT. Enter must not close the palette on a command that
    // cannot run: runCommand would return early (its own disabled-command
    // semantics) and the palette would have vanished with nothing done and no
    // explanation. Staying open leaves the reason on screen, which is the whole
    // point of showing the row. Not a silent failure — the bottom section is
    // already saying why, in the sentence the entry itself declares.
    if (commandUnavailable(cmd, app)) return;
    if (cmd.children) {
      stack = [...stack, cmd];
      query = "";
      resetHighlight();
      inputEl.focus();
    } else {
      // COMMIT the previewable-command protocol: if we happened to be previewing
      // a DIFFERENT entry, revert that one; then drop any pending revert for THIS
      // entry WITHOUT calling it (its previewed change stays) so the effect —
      // which fires when closing empties `results` — sees previewedId === null
      // and reverts nothing. `run` then applies the change durably (e.g. persists
      // the theme). In normal use the clicked/entered row is already highlighted,
      // so previewedId === cmd.id and the first branch is a no-op.
      if (previewRevert && previewedId !== cmd.id) previewRevert();
      previewRevert = null;
      previewedId = null;
      // RUN FIRST, THEN CLOSE — and only if the command did not raise a SECOND
      // STAGE. A command whose action needs one per-document argument answers by
      // setting app.palettePicker (R7-42), and the palette must stay open on it:
      // closing first and reopening would restart this component's own open
      // effect, which clears the query and the stack. The palette does not need
      // to know WHICH commands do this — it asks afterwards, so a picker raised
      // by any future command works with no edit here.
      app.runCommand(cmd.id); // routes through MRU tracking
      if (app.palettePicker) {
        stack = [];
        query = "";
        resetHighlight();
        inputEl.focus();
      } else {
        app.paletteOpen = false;
      }
    }
  }

  function back() {
    // FROM THE PICKER, BACK IS THE COMMAND LIST — one Escape (or Backspace on an
    // empty query) undoes the step that opened it, exactly as it undoes a submenu
    // drill. A second one then closes the palette.
    if (picking) closePicker();
    else if (stack.length) {
      stack = stack.slice(0, -1);
      query = "";
      resetHighlight();
    } else {
      app.paletteOpen = false;
    }
  }

  function onkeydown(e) {
    if (e.key === "Escape") back();
    else if (e.key === "Backspace" && query === "" && (stack.length || picking)) back();
    else if (e.key === "ArrowDown") {
      highlighted = Math.min(highlighted + 1, rowCount - 1);
      scrollHighlightedIntoView();
    } else if (e.key === "ArrowUp") {
      highlighted = Math.max(highlighted - 1, 0);
      scrollHighlightedIntoView();
    } else if (e.key === "Enter" && current) {
      // ONE KEY, WHICHEVER STAGE IS UP — the whole two-step is keyboard-drivable
      // without learning a second set of keys: open, type, Enter onto the
      // command, type again, Enter onto the type.
      if (picking) pick(current);
      else activate(current);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#if app.paletteOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-backdrop" onpointerdown={() => (app.paletteOpen = false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="palette" onpointerdown={(e) => e.stopPropagation()}>
      <!-- THE PICKER STAGE BORROWS THE BREADCRUMB, not a new affordance: it is
           the same "you are one level in, Backspace goes back" statement a
           submenu drill makes, and the two are mutually exclusive. -->
      {#if picking}
        <div class="palette-crumbs">{app.palettePicker.title}</div>
      {:else if stack.length}
        <div class="palette-crumbs">
          <!-- Separator is an mdi chevron (iconify-only rule — the "›" glyph
               is in the manifest's banned set), matching the row sub-arrow. -->
          {#each stack as s, i}{#if i > 0}<iconify-icon class="crumb-sep" icon="mdi:chevron-right" width="12" height="12"></iconify-icon>{/if}{s.title}{/each}
        </div>
      {/if}
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onkeydown}
        oninput={resetHighlight}
        placeholder={picking ? app.palettePicker.placeholder : parent ? `${parent.title}…` : "Type a command…"}
        spellcheck="false"
      />
      <div
        class="palette-results"
        bind:this={resultsEl}
        onpointermove={notePointer}
        onwheel={noteUserScroll}
        ontouchmove={noteUserScroll}
        onscroll={followPointerAfterScroll}
      >
        {#if picking}
          <!-- THE PICKER ROWS. Deliberately the SAME `.palette-item` button, the
               same icon slot, the same fuzzy <mark>ing and the same pointermove
               highlight rule as a command row — the stage changed, not the
               surface, so nothing here is a second way to read a list. What is
               absent is what a picker option genuinely lacks: no availability
               gate (it is offered because it exists on this slide), no submenu
               arrow, no shortcut, no owning submenu. The COUNT rides in the
               `detail` slot on the right, where a command row shows its
               shortcut — the information the minted rows carried in a "(3)"
               suffix, now beside the name instead of glued into it. -->
          {#each pickerOptions as opt, i (opt.value)}
            <button
              class="palette-item"
              data-command-id={opt.value}
              class:highlighted={i === highlighted}
              onpointermove={(e) => {
                notePointer(e);
                highlighted = i;
              }}
              onclick={() => pick(opt)}
            >
              <span class="icon-slot">
                {#if opt.icon}
                  <iconify-icon icon={opt.icon} width="16" height="16"></iconify-icon>
                {/if}
              </span>
              <span class="title"
                >{#each titleSegments(opt.label, query) as seg}{#if seg.hit}<mark class="fuzzy-hit">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
              >
              {#if opt.detail}<span class="palette-in">{opt.detail}</span>{/if}
            </button>
          {/each}
          {#if !pickerOptions.length}
            <div class="palette-none">No matching widget types</div>
          {/if}
        {:else}
        {#each rows as cmd, i (cmd.id)}
          <!-- Hover-highlight keys on pointerMOVE, not pointerenter: keyboard
               navigation scrolls the list, which slides rows UNDER a stationary
               cursor — that fires pointerenter (yanking the highlight off the
               keyboard row) but never pointermove, which only fires on genuine
               mouse movement. So hover still highlights instantly, and hover
               and keyboard can't fight (the VS Code list rule). -->
          <!-- ONE gate evaluation per row, done up in the partition. `when` is not
               free (needsMultiBbox derives the render tree) and three things need
               the same answer — where the row sits, its class, its aria state — so
               it is asked once and read from the set. -->
          {@const off = unavailableIds.has(cmd.id)}
          <!-- aria-disabled, NOT the native `disabled` attribute: a disabled
               button fires no pointer events, so hovering it could not report
               why it is disabled — the one thing the user asked for. The guard
               is in activate() instead, and it is the same guard for the click
               and for Enter.
               data-command-id makes the row say WHICH command it is: the title is
               the human name, not the identity, and a surfacing of the registry
               should carry the key it was surfaced from (the ordering probe reads
               it to check the partition against search()'s own output). -->
          <button
            class="palette-item"
            data-command-id={cmd.id}
            class:highlighted={i === highlighted}
            class:unavailable={off}
            aria-disabled={off}
            onpointermove={(e) => {
              notePointer(e);
              highlighted = i;
            }}
            onclick={() => activate(cmd)}
          >
            <!-- Fixed-width icon slot (same width whether filled or blank, so
                 titles align — user spec). -->
            <span class="icon-slot">
              {#if cmd.icon}
                <iconify-icon icon={cmd.icon} width="16" height="16"></iconify-icon>
              {/if}
            </span>
            <span class="title"
              >{#each titleSegments(cmd.title, query) as seg}{#if seg.hit}<mark class="fuzzy-hit">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
            >
            <!-- WHERE A CHILD LIVES, shown only when the query surfaced it from inside a
                 submenu the author has not drilled into. Without it a top-level search for
                 "drone" offers three rows reading "Ambient Drone", "Drone Patch" and
                 "Building an Ambient Drone" with nothing to say that two are audio patches
                 and one is a preset. Suppressed while drilled in, where the parent is
                 already the placeholder text and repeating it on every row is noise. -->
            {#if !parent}
              {@const owner = app.commands.parentOf(cmd.id)}
              {#if owner}<span class="palette-in">{owner.title}</span>{/if}
            {/if}
            {#if app.shortcuts.commandKeys(cmd.id)}
              <span class="shortcut">
                <KeyCombo keys={app.shortcuts.commandKeys(cmd.id)} />
              </span>
            {/if}
            {#if cmd.children}<iconify-icon class="sub-arrow" icon="mdi:chevron-right" width="16" height="16"></iconify-icon>{/if}
          </button>
        {/each}
        {#if !rows.length}
          <div class="palette-none">No matching commands</div>
        {/if}
        {/if}
      </div>
      <!-- THE HELP SECTION. Rendered only when the highlighted entry actually has
           something to say — `help` (what it does and why you would want it) or,
           while its gate says no, the reason. The reason uses the SAME sentence
           and the same .tool-tip-requires class the Toolbar and the Tools pane
           use, so a disabled control explains itself identically wherever it is
           surfaced. `help` is a plain string today; a richer form is a later
           change to this one block. -->
      {#if currentHelp || currentReason}
        <div class="palette-help">
          {#if currentHelp}<div class="palette-help-text">{currentHelp}</div>{/if}
          {#if currentReason}<div class="tool-tip-requires">{unavailableMessage(currentReason)}</div>{/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
