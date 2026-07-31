<!--
  CanvasToolbar — THE SPEC RENDERER for a widget's floating canvas bar. Opened by
  DOUBLE-CLICKING a widget whose plugin declares `floatingToolbar(state)`, and
  mounted inside web/FloatingCanvasPanel.svelte, which owns every positioning
  decision (anchor, the flip near the top edge, the pointer-events discipline, the
  no-transform rule). This file owns only WHAT IS IN the panel.

  DECLARATIVE, GENERAL MECHANISM: a plugin returns a toolbar SPEC — analogous to
  how it declares inspector rows — and this component renders it. There are three
  content kinds, and a spec may carry any combination of them (the globe/map popup
  uses `toggles` AND `fields` together — layer buttons above, coordinate entry
  below, in the SAME panel):

    { grid: { property, value, cells: [{value, label, svg}], labelKind } }
        A visual PICKER. Each cell is its own SVG thumbnail; clicking one writes
        `property = cell.value`. The cursor widget picks a cursor this way instead
        of through an Inspector dropdown.
        `labelKind` says what a cell's `label` IS, and the only thing it decides is
        TYPOGRAPHY: "text" (the default) is prose — a human title like "Spinning" —
        and renders in the app font; "id" is an IDENTIFIER — "tabler:star" — and
        renders in --a-mono, the app's one voice for identifiers and equations
        (.varspanel .var-name, .cmd-tip-url). The plugin has to say which, because
        the toolbar cannot tell them apart and guessing wrong is the inconsistency
        the user reported ("I'm okay with monospace, except it's not consistent").

    { fields: [{ id, label, value, keys, size, help }] }
        An editable READOUT. Each field is a text input showing `value`; committing
        one asks the plugin `fieldWrites(state, id, text)` for the state writes it
        means. The plugin owns BOTH directions, which is what lets one field stand
        for several stored leaves — the Mandelbrot's Re/Im each show the exact
        decimal sum of a coarse+fine SPLIT coordinate and take a 30-digit paste
        back apart losslessly, which a raw per-leaf row cannot do.

    { toggles: { groups: [{ label, buttons: [{id, label, active, keys}] }] } }
        TEXT-LABELED BUTTON ROWS — the general mechanism for "several mutually
        exclusive or independent on/off choices, mirrored from the Inspector onto
        the canvas". Each GROUP renders as its own row (an optional `label` reads
        as a small caption to its left); each BUTTON in a group commits through
        `toggleWrites(state, id)` exactly the way a field commits through
        `fieldWrites` — the plugin owns what clicking a button MEANS (write one
        property, write several, flip a boolean), the toolbar only renders `active`
        and dispatches the click. This is what lets the globe/map popup mirror its
        Inspector's basemap SELECT and its per-overlay BOOLEAN rows through the
        exact same command path with no parallel state: `active` is computed from
        the SAME folded state the Inspector reads, and `toggleWrites` returns the
        SAME shape `fieldWrites` does.
        A button's `keys` (like a field's) names the stored leaves it would write;
        BOUND-TO-EQUATION disables it with the same tooltip sentence a field shows,
        for the same reason (clicking would silently overwrite the binding).

  A field or toggle button is DISABLED when any of the stored leaves it names in
  `keys` holds an `=` equation. That is the ruling interior explore already makes
  for the same situation (interiorNav's equationBoundInteriorProps): committing
  would overwrite the equation with the number it currently evaluates to, so the
  bar refuses and says where to edit it instead. Silently clobbering a binding is
  not an option.

  HOVERING a grid cell LIVE-PREVIEWS it on the widget: preview() stages the same
  property write into app.previewDelta (the viewport re-renders it; the document is
  untouched and no undo entry is created), each pointerenter overwrites the last,
  and leaving the GRID reverts via app.cancelPreview(). This is the ToolsPane preset
  card-grid contract applied to a cell grid — the house rule that a palette
  selection previews under the pointer before you commit to it. FIELDS and TOGGLES
  do not preview: there is no meaningful hover for a text field, and a toggle
  button's whole point is a single decisive click, not a hover-scrub.

  Styling lives in app.css (.canvas-toolbar-*; the app convention: NO <style>
  block, every color/size from an --a-* token).
-->
<script>
  import { untrack } from "svelte";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import FloatingCanvasPanel, { widgetPanelAnchor } from "./FloatingCanvasPanel.svelte";
  import { isEquationValue } from "../core/expressions.js";
  import { onConnectivityChange } from "./connectivity.js";

  // app = the app store; node = the widget's derived render node; worldToScreen =
  // the PanZoom camera map (render-area frame); zoom = viewport.zoom (kept for
  // parity with the sibling controllers / future zoom-aware sizing).
  let { app, node, worldToScreen, zoom } = $props();

  // The plugin's declarative toolbar spec for this widget's current state.
  let spec = $derived(node.plugin.floatingToolbar?.(node.state) ?? null);

  // The panel anchor: the widget's top/bottom centre in render-area screen px.
  // FloatingCanvasPanel decides which edge to hang from.
  let anchor = $derived(widgetPanelAnchor(node, worldToScreen));

  // ── SEARCHABLE grids (spec.search — the iconify palette) ────────────────────
  // A spec may pair its grid with a search PROVIDER: {placeholder, run(query) →
  // Promise<cells>}. The toolbar owns the input and the debounce and swaps the
  // grid's cells per query, so the plugin stays declarative (it never sees the
  // input) and the grid keeps its preview→commit mechanics unchanged. The
  // provider is async because the cells are fetched (the iconify search API);
  // a static grid (the cursor palette) has no `search` and none of this runs.
  const SEARCH_DEBOUNCE_MS = 250; // one keystroke-pause, not one request per key
  let query = $state("");
  let searchCells = $state(null); // null until the first (empty-query) fill lands
  let searchStatus = $state(""); // "", "Searching…", "No results", or a loud provider error
  let searchSeq = 0; // stale-response guard: only the LATEST query may install cells

  // Whether the current spec is searchable — a stable boolean, so the effect
  // below does NOT rerun on every spec recompute (each hover-preview re-derives
  // the spec; re-searching on hover would be absurd).
  let searchable = $derived(!!spec?.search);

  /** Command (async). Runs the spec's search provider for `q` and installs the
   * result — unless a newer query started meanwhile (the seq guard). A provider
   * failure is LOUD: named in the status line and reported to the console. */
  async function runSearch(q) {
    const seq = ++searchSeq;
    searchStatus = "Searching…";
    try {
      const cells = await spec.search.run(q);
      if (seq !== searchSeq) return; // a newer query superseded this one
      searchCells = cells;
      searchStatus = cells.length ? "" : "No results";
    } catch (e) {
      if (seq !== searchSeq) return;
      searchCells = [];
      searchStatus = e instanceof Error ? e.message : String(e);
      console.error(`PowerRP CanvasToolbar: icon search failed — ${searchStatus}`);
    }
  }

  // The initial (empty-query) fill on mount, then a debounced run per keystroke.
  // The timer is the effect's cleanup, so typing inside the window reschedules.
  // untrack keeps the provider call from subscribing this effect to `spec`.
  let firstSearch = true;
  $effect(() => {
    if (!searchable) return;
    const q = query;
    if (firstSearch) {
      firstSearch = false;
      untrack(() => runSearch(q));
      return;
    }
    const timer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // RECOVERY: a search that failed because the internet was gone must come back
  // BY ITSELF when it returns. Without this the palette keeps showing "Offline —
  // icon search needs the internet" over a wifi connection that is plainly
  // working, and the only way out is to retype the query — which reads as the
  // notice being wrong rather than merely stale.
  //
  // Only the ONLINE edge re-runs, and only when the last attempt actually
  // failed: going offline needs no request to be correct (the provider refuses
  // before it fetches), and re-running a SUCCESSFUL search on every network
  // blip would burn requests to reproduce results already on screen.
  $effect(() => {
    if (!searchable) return;
    return onConnectivityChange((up) => {
      if (up && searchStatus) untrack(() => runSearch(query));
    });
  });

  /** Command. Keydown in the search input: Enter searches NOW (skips the
   * debounce), Escape leaves the input. Both stopPropagation so the canvas's
   * own key handling stays out of a text field (the field-row ruling). */
  function onSearchKey(e) {
    if (e.key === "Enter") {
      e.stopPropagation();
      runSearch(e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      e.currentTarget.blur();
    }
  }

  // What the grid shows: the async results when searchable, else the spec's
  // own static cells (the cursor grid) — one template, two content sources.
  let gridCells = $derived(searchable ? (searchCells ?? []) : (spec?.grid?.cells ?? []));

  // THE THUMBNAIL INK — the theme's --fg, substituted into each cell's SVG for
  // `currentColor` (see inkedSvg below for why an <img> leaves us no choice).
  // Reading `app.theme` here is what makes this re-derive on a theme switch: the
  // token itself is not reactive, so the state that CHANGES it has to be the
  // dependency. That is CanvasView's paintGrid contract, which touches app.theme
  // for exactly the same reason (its grid line colour also comes from --fg).
  let ink = $derived.by(() => {
    app.theme;
    return themeInk();
  });

  // Whether OUR hover currently owns app.previewDelta. A PLAIN (non-$state)
  // bridge variable — written and read imperatively, it must never drive a
  // re-render — following CommandPalette's previewRevert/previewedId.
  let previewing = false;

  /** Command. Live-previews `value` on the widget's grid property WITHOUT
   * committing: stages it into app.previewDelta so the viewport (and this
   * grid's own selected ring, which reads the derived state) shows the hovered
   * cell, while the document stays untouched and no undo entry is created. The
   * next hover overwrites it; leaving the grid reverts it. */
  function preview(property, value) {
    previewing = true;
    app.setPreview([[["items", node.itemId, property], value]]);
  }

  /** Command. Reverts the hover preview. Guarded on `previewing` so a revert
   * that lands after a commit — or while another surface owns previewDelta —
   * never discards someone else's staged change. */
  function revert() {
    if (!previewing) return;
    previewing = false;
    app.cancelPreview();
  }

  /** Command. Writes the picked value onto the widget's grid property as ONE
   * undo unit (the standard preview→commit seam the Inspector uses). Re-staging
   * the value keeps a pointer-less activation (Enter on a focused tile, which
   * fires no pointerenter) on the same path; commitPreview consumes the stage,
   * so the hover no longer owns it. */
  function pick(property, value) {
    app.setPreview([[["items", node.itemId, property], value]]);
    app.commitPreview();
    previewing = false;
  }

  /** Query. The stored leaves of `field` (a field OR a toggle button — both
   * shapes carry `.keys`) that hold an `=` equation, as keys. Empty when it is
   * free to activate. The stored value is read (never the derived one) because
   * that is where an equation still IS an equation. */
  function boundKeys(field) {
    return (field.keys ?? []).filter((key) => isEquationValue(node.plugin, [key], app.storedItemValue(node.itemId, [key])));
  }

  /** Command. Commits a toggle button's click as ONE undo unit, through the
   * plugin's own `toggleWrites(state, id)` — the same shape `fieldWrites` returns,
   * so a button is exactly "a field whose typed text is fixed to its own id". No
   * preview: a toggle's whole point is a single decisive click. */
  function commitToggle(button) {
    const writes = node.plugin.toggleWrites?.(node.state, button.id);
    if (!writes) return;
    app.setPreview(Object.entries(writes).map(([key, value]) => [["items", node.itemId, key], value]));
    app.commitPreview();
  }

  /** Command. Commits a field's typed text as ONE undo unit, through the plugin's
   * own `fieldWrites`. Text the plugin does not accept commits NOTHING and the
   * input is restored from the spec, so a typo cannot half-write a coordinate.
   *
   * GUARDED ON AN OPEN DRAFT, and that guard is load-bearing: Enter commits and then
   * BLURS the input, and blur is itself a commit path (clicking away must not discard
   * what was typed). Measured without the guard, one Enter produced TWO identical
   * commits — two undo entries for one edit, so the first undo appeared to do nothing.
   * Clearing the draft first makes the second call a no-op, which is also what makes
   * opening a field and leaving it untouched commit nothing at all. */
  function commitField(field, text) {
    if (draft[field.id] === undefined) return;
    draft = { ...draft, [field.id]: undefined }; // fall back to the spec's value
    const writes = node.plugin.fieldWrites?.(node.state, field.id, text);
    if (!writes) return;
    app.setPreview(Object.entries(writes).map(([key, value]) => [["items", node.itemId, key], value]));
    app.commitPreview();
  }

  // Per-field IN-PROGRESS text, by field id. A field shows its draft while being
  // typed in and the SPEC's value otherwise — so a gesture that moves the view
  // updates every field the moment it happens, and typing is never overwritten
  // mid-keystroke by the value the field is about to replace.
  let draft = $state({});

  /** Pure function. What a field's input shows: the live draft if one is open,
   * else the spec's own value.
   * @example // shown({id: "zoom", value: "6"}) with no draft → "6" */
  function shown(field) {
    return draft[field.id] ?? field.value;
  }

  /** Command. Keydown in a field: Enter commits, Escape abandons the draft. Both
   * stopPropagation so the canvas's own Escape (which would exit explore mode)
   * does not fire while a field is being edited — the in-place text editor's
   * ruling, applied here. */
  function onFieldKey(e, field) {
    if (e.key === "Enter") {
      e.stopPropagation();
      commitField(field, e.currentTarget.value);
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      draft = { ...draft, [field.id]: undefined };
      e.currentTarget.blur();
    }
  }

  // The toolbar can UNMOUNT with the pointer still over a tile (Escape, a
  // deselect, or a purge closes it), which fires no pointerleave — so the
  // revert must not depend on one (the GradientPresetPicker close() rule).
  // Without this a staged hover would outlive the grid and be baked into the
  // document by the NEXT commitPreview from anywhere in the app.
  $effect(() => {
    return () => revert();
  });
</script>

{#if spec?.grid || spec?.fields || spec?.toggles}
  <FloatingCanvasPanel x={anchor.x} topY={anchor.topY} bottomY={anchor.bottomY} label={spec.label ?? "Widget toolbar"}>
    {#snippet children()}
      {#if spec.search}
        <!-- The searchable palette's input (spec.search) — the toolbar owns it;
             results replace the grid's cells below. The status line narrates
             in-flight / empty / failed searches so a blank grid is never mute. -->
        <div class="canvas-toolbar-search">
          <input
            type="text"
            class="canvas-toolbar-field-input canvas-toolbar-search-input"
            placeholder={spec.search.placeholder ?? "Search…"}
            aria-label={spec.search.placeholder ?? "Search"}
            spellcheck="false"
            bind:value={query}
            onkeydown={onSearchKey}
          />
          {#if searchStatus}<span class="canvas-toolbar-search-status">{searchStatus}</span>{/if}
        </div>
      {/if}
      {#if spec.grid}
        <!-- pointerleave on the GRID (not each tile) reverts only when the
             pointer leaves the tiles entirely; moving BETWEEN tiles fires each
             one's pointerenter, overwriting the preview without a revert in
             between (the ToolsPane preset card-grid precedent). -->
        <div
          class="canvas-toolbar-grid"
          role="listbox"
          aria-label={spec.label ?? "Palette"}
          tabindex="-1"
          style={spec.grid.cols ? `--a-canvas-toolbar-cols: ${spec.grid.cols}` : null}
          onpointerleave={revert}
        >
          {#each gridCells as cell (cell.value)}
            <!-- Cell name on hover via SvelteLib's immediate Tooltip (native
                 title= is banned in app chrome — manifest). Its anchor is
                 display:contents, so the button stays the grid item AND the
                 listbox's own option child. NOTE: the tip is position:fixed, so
                 the panel must not carry a transform — see FloatingCanvasPanel.

                 The `tip` snippet rather than plain `text` so the label can carry
                 a CLASS: an "id" label is an identifier and wears --a-mono (the
                 .cmd-tip-url precedent — a literal read character by character),
                 a "text" label is prose and wears the app font. spec.grid.labelKind
                 is what distinguishes them; see the header. `disabled` restores the
                 guard the snippet form loses: Tooltip's own hasContent test is
                 `!!tip || text.length > 0`, so a snippet is ALWAYS content and an
                 unlabelled cell would pop an empty tip box on hover. -->
            <Tooltip disabled={!cell.label}>
              {#snippet tip()}
                <span class="canvas-toolbar-tile-label" class:identifier={spec.grid.labelKind === "id"}>{cell.label}</span>
              {/snippet}
              <button
                type="button"
                class="canvas-toolbar-tile"
                class:selected={cell.value === spec.grid.value}
                role="option"
                aria-selected={cell.value === spec.grid.value}
                onpointerenter={() => preview(spec.grid.property, cell.value)}
                onclick={() => pick(spec.grid.property, cell.value)}
              >
                <img class="canvas-toolbar-thumb" src={dataUri(cell.svg, ink)} alt={cell.label} draggable="false" />
              </button>
            </Tooltip>
          {/each}
        </div>
      {/if}
      {#if spec.toggles}
        <!-- One row per group (base style, each overlay, view mode, …). A group's
             own `label` is an optional small caption — omitted for a self-evident
             row (there is only one basemap row; a per-overlay row is one button
             wide and needs no caption of its own). -->
        <div class="canvas-toolbar-toggles">
          {#each spec.toggles.groups as group, gi (group.label ?? gi)}
            <div class="canvas-toolbar-row">
              {#if group.label}<span class="canvas-toolbar-field-label">{group.label}</span>{/if}
              {#each group.buttons as button (button.id)}
                {@const bound = boundKeys(button)}
                <Tooltip text={bound.length ? `${bound.join(", ")} ${bound.length === 1 ? "is an" : "are"} = equation — edit it in the Inspector; clicking here would overwrite it with its current value.` : button.help}>
                  <button
                    type="button"
                    class="btn"
                    class:active={button.active}
                    aria-pressed={button.active}
                    disabled={bound.length > 0}
                    onclick={() => commitToggle(button)}
                  >
                    {button.label}
                  </button>
                </Tooltip>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
      {#if spec.fields}
        <div class="canvas-toolbar-fields">
          {#each spec.fields as field (field.id)}
            {@const bound = boundKeys(field)}
            <!-- KEEPS the "typing here would overwrite it" clause — that is why
                 the field is inert, and without it the control looks broken —
                 but as a clause rather than a second sentence. -->
            <Tooltip text={bound.length ? `${bound.join(", ")} ${bound.length === 1 ? "is an" : "are"} = equation — edit it in the Inspector; typing here would overwrite it with its current value.` : field.help}>
              <label class="canvas-toolbar-field" class:narrow={field.size === "narrow"}>
                <span class="canvas-toolbar-field-label">{field.label}</span>
                <input
                  type="text"
                  class="canvas-toolbar-field-input"
                  data-hint-scope="commit"
                  spellcheck="false"
                  disabled={bound.length > 0}
                  value={shown(field)}
                  oninput={(e) => (draft = { ...draft, [field.id]: e.currentTarget.value })}
                  onkeydown={(e) => onFieldKey(e, field)}
                  onblur={(e) => commitField(field, e.currentTarget.value)}
                />
              </label>
            </Tooltip>
          {/each}
        </div>
      {/if}
    {/snippet}
  </FloatingCanvasPanel>
{/if}

<script module>
  /** Ink to fall back to when no computed style can resolve --fg (a non-DOM path).
   *  A mid grey, deliberately: legible against a dark AND a light panel, so a
   *  failure to read the theme degrades to "dim" rather than to "invisible". */
  const INK_FALLBACK = "#808080";

  /**
   * Pure function. `svg` with every `currentColor` replaced by `ink`.
   *
   * WHY THIS EXISTS. The monochrome Iconify sets (tabler, mdi, lucide, weui…) are
   * authored with `fill="currentColor"` / `stroke="currentColor"` so a host page can
   * colour them by CSS inheritance. A tile thumbnail is an `<img src="data:…">`,
   * and an `<img>` is a SEPARATE document: no CSS crosses into it, so `currentColor`
   * resolves against the SVG's OWN initial color — black. MEASURED at baseline: on
   * the graphite theme the palette drew black glyphs on an rgb(26,26,26) panel, the
   * user's report "It's dark on dark right now." Substituting the ink into the
   * markup is the only fix available to an `<img>`; the alternative (inline the SVG
   * so it inherits) would hand 50 untrusted remote documents to the DOM.
   *
   * ONLY WHERE `currentColor` APPEARS. Full-colour sets (logos, twemoji, flags…)
   * carry explicit colours and must pass through byte-identical — recolouring a
   * brand logo would be worse than the bug. A string with no `currentColor` is
   * returned unchanged, which is exactly what replace() does anyway.
   *
   * @param {string} svg - the icon's SVG text
   * @param {string} ink - a CSS colour, e.g. the theme's --fg
   * @returns {string}
   *
   * @example inkedSvg('<path fill="currentColor" d="M0 0"/>', "#e6e6e6")
   * @example // '<path fill="#e6e6e6" d="M0 0"/>'
   * @example inkedSvg('<path fill="#74aa9c" d="M0 0"/>', "#e6e6e6") // unchanged — a full-colour logo
   * @example // '<path fill="#74aa9c" d="M0 0"/>'
   */
  function inkedSvg(svg, ink) {
    return svg.replaceAll("currentColor", ink);
  }

  /** Pure function. A self-contained SVG data URI for an <img> thumbnail, with
   * `currentColor` resolved to `ink` (see inkedSvg for why that substitution is
   * the only option inside an <img>).
   * @example dataUri("<svg/>", "#fff").startsWith("data:image/svg+xml,") // true
   * @example decodeURIComponent(dataUri('<svg fill="currentColor"/>', "#fff"))
   * @example // 'data:image/svg+xml,<svg fill="#fff"/>'
   */
  function dataUri(svg, ink) {
    return `data:image/svg+xml,${encodeURIComponent(inkedSvg(svg, ink))}`;
  }

  /** Query. The theme's foreground colour as a concrete CSS colour string, read
   * off :root — the ink a `currentColor` thumbnail must be drawn in so it contrasts
   * with the panel it sits on. Falls back to INK_FALLBACK with no DOM.
   * @example themeInk() // "#e6e6e6" on graphite (dark); "#2b221a" on desert (light)
   */
  function themeInk() {
    if (typeof getComputedStyle === "undefined") return INK_FALLBACK;
    return getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || INK_FALLBACK;
  }
</script>
