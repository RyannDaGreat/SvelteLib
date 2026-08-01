<!--
  FileBrowser — ONE navigable view of every store this editor can reach
  (R6-19). Renderings, assets, project documents, the offline app cache and the
  bundled library, under one set of breadcrumbs, in both storage modes.

  IT OWNS NO STORAGE KNOWLEDGE. Every listing, every byte and every honest
  caveat comes from web/storageTree.js (the seam) and web/storagePath.js (the
  grammar); this file is the view and nothing else. In particular it does NOT
  re-enumerate anything the Debug console's Storage page already enumerates —
  both read the same gatherers, which is why the two can never disagree about
  what this origin holds.

  WHAT IT IS NOT. It is not a second Asset Explorer: there is no upload, no
  insert-onto-canvas, no drag payload, no delete. That last one is a SAFETY
  choice stated in the capability sentences — the Asset Explorer's trash counts
  the widgets still pointing at a file before it asks, and the Render Center
  knows whether a job is still encoding. A delete button here would bypass both.

  NAVIGATION (R6-19.4): a folder row descends, Up climbs one level (disabled at
  a root, where there is nothing above), Home returns to the project directory —
  which for an unsaved draft is `local:/~draft/current` in EVERY storage mode,
  because that is where its bytes actually are.

  PREVIEW (R6-19.3): a row draws the FILE — AssetThumb, the app's one thumbnail
  layer, the same one the Asset Explorer grid and the AssetField picker use.
  POINTING at a row describes it in the detail pane (todo #165's hover-to-preview,
  and it is free here: selection reads no bytes). CLICKING a file reads its bytes
  and shows the inline preview; that is the one gesture that costs anything, and
  it stays deliberate.

  HONESTY (the point of the whole exercise): every row carries a `note` naming
  what actually backs it, shown on hover, because the directory illusion is only
  partly true — root→keyspace and category→file are real enumerations, while
  keyspace→category is a real directory on the server and a presentation
  grouping in the browser store. A row never hides which one it is.

  Chrome per house rules: NO <style> block (all classes in app.css via --a-*
  tokens), square corners, iconify glyphs only, SvelteLib Tooltip for hover help
  (native title= is banned).
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import AssetThumb from "./AssetThumb.svelte";
  import CsvTable from "./CsvTable.svelte";
  import { humanReadableFileSize } from "./fileSize.js";
  import { relativeMtime } from "./projectPreviews.js";
  import { breadcrumbs, filterEntries, parentPath, parsePath, sortEntries } from "./storagePath.js";
  import { activeRoots, downloadEntry, homePath, listPath, PREVIEW_TEXT_BYTES, PREVIEW_WHOLE_FILE, previewOfBlob, readPath, releasePreview, rootFor } from "./storageTree.js";

  // `at` is where a REVEAL affordance wants this opened (a Render Center row, an
  // asset tile). It seeds the initial path ONCE; navigating from there is the
  // component's own business, so it is read at construction rather than tracked.
  let { app, at = null } = $props();

  let path = $state(at ?? homePath(app));
  let entries = $state([]);
  let errors = $state([]);
  let loading = $state(true);
  let query = $state("");
  /** The selected entry's path, or null. Selection is what the detail panel and
   *  the download affordance read; it survives a re-list only if the row is
   *  still there (see refresh).
   *
   *  HOVER SETS IT (todo #165 — hover-to-preview is this app's default trope for
   *  every picker, and a browser whose whole purpose is "what IS this file" is
   *  the surface it helps most). Hover is free here BY CONSTRUCTION: selecting
   *  reads no bytes, only the listing metadata that is already in memory, so
   *  sweeping the list costs one object-URL revoke per row and nothing else.
   *  Reading the bytes is still a deliberate act — see `loadPreview`. */
  let selectedPath = $state(null);
  /** previewOfBlob's output for the selected file, or null when it has none yet.
   *  Released (object URL revoked) whenever the selection changes. */
  let preview = $state(null);
  /** A row action that failed, as ONE visible sentence. It renders ABOVE the
   *  listing rather than instead of it — the same rule DebugStoragePage and the
   *  Asset Explorer follow, so a failed download never erases what you are
   *  reading. */
  let actionError = $state(null);
  /** Captured ONCE per listing so every row's relative age is measured against
   *  the same instant — the Asset Explorer's `listedNowMs` rule, kept because
   *  otherwise rows drawn in one frame can disagree by a second. */
  let listedNowMs = $state(Date.now());

  const parsed = $derived(parsePath(path));
  const root = $derived(rootFor(parsed.root));
  const crumbs = $derived(breadcrumbs(path, root.label));
  const upPath = $derived(parentPath(path));
  const shown = $derived(filterEntries(sortEntries(entries), query));
  const selected = $derived(shown.find((e) => e.path === selectedPath) ?? null);
  const noMatches = $derived(entries.length > 0 && shown.length === 0);

  /** Command (mutates this component's state; reads every store the path
   *  touches). Re-list the current path. `listPath` returns {entries, errors}
   *  and NEVER swallows, so a store that failed shows its sentence instead of
   *  reading as an empty folder. */
  async function refresh() {
    loading = true;
    const result = await listPath(path);
    entries = result.entries;
    errors = result.errors;
    listedNowMs = Date.now();
    loading = false;
  }

  /** Command (mutates `path` and the selection). Navigate to a path and drop the
   *  selection, which belonged to the folder being left. */
  function goTo(next) {
    select(null);
    actionError = null;
    path = next;
  }

  /** Command (mutates `selectedPath`/`preview`). Select one row, releasing the
   *  previous row's object URL. Re-selecting the SAME row is a no-op, so moving
   *  the pointer within a row never discards a preview it already loaded. */
  function select(entryPath) {
    if (entryPath === selectedPath) return;
    releasePreview(preview);
    preview = null;
    selectedPath = entryPath;
  }

  /** Command (reads bytes; mutates `preview`/`actionError`). Load the selected
   *  file's inline preview. Not automatic on selection: reading a multi-gigabyte
   *  rendering because the pointer crossed a row is exactly the cost this browser
   *  should not impose on a glance.
   *
   *  A TABLE GETS THE WHOLE FILE, everything else a peek. CsvTable is a virtual
   *  scroller written for a 100,000-row file, and a peek handed to it is not
   *  merely partial — the cut lands mid-line, so the last row is MANGLED and
   *  nothing on screen says so. The peek's own truncation is reported by
   *  `preview.truncated`, which the markup renders as a sentence. */
  async function loadPreview(e) {
    actionError = null;
    try {
      const budget = e.kind === "data" ? PREVIEW_WHOLE_FILE : PREVIEW_TEXT_BYTES;
      preview = await previewOfBlob(await readPath(e.path), e.kind, budget);
    } catch (err) {
      actionError = `Couldn't read “${e.name}” — ${err?.message ?? err}`;
      console.error(`FileBrowser: could not read "${e.path}":`, err);
    }
  }

  /** Command (downloads a file; mutates `actionError`). Save one entry to disk
   *  through the seam's one download definition. A failure lands on the visible
   *  error line as well as the console — a download that did not happen must
   *  never look like one that did. */
  async function download(e) {
    actionError = null;
    try {
      await downloadEntry(e);
    } catch (err) {
      actionError = `Couldn't download “${e.name}” — ${err?.message ?? err}`;
      console.error(`FileBrowser: could not download "${e.path}":`, err);
    }
  }

  /** Command (mutates `path`, or selects and reads bytes). A row's primary
   *  gesture: a folder DESCENDS, a file SELECTS and opens its inline preview.
   *
   *  IT SELECTS EVEN THOUGH HOVER ALREADY DID. Hover is an ACCELERATOR, never the
   *  only route — a touch screen has no hover at all, so a click-only device would
   *  otherwise be able to open a preview of a file the detail pane never admitted
   *  was chosen. (Measured, not theorised: tests/file_browser_probe.js clicks rows
   *  without a pointer ever entering them, and three of its assertions went red the
   *  moment selection depended on hovering.) `select` is a no-op on the row that is
   *  already selected, so the common pointer path costs nothing extra. */
  function activate(e) {
    if (e.type === "dir") return goTo(e.path);
    select(e.path);
    loadPreview(e);
  }

  /** Pure function. One row's detail line: size and age, each omitted when
   *  genuinely unknown rather than printed as 0 or "just now".
   *
   *  @param {object} e - a storageTree entry
   *  @returns {string}
   *
   *  @example detailLine({bytes: 8213, mtime: 1769800000})  // "8.0KB · 2 hours ago"
   *  @example detailLine({bytes: null, mtime: null})        // "size unknown"
   */
  function detailLine(e) {
    const parts = [];
    parts.push(e.bytes === null ? "size unknown" : humanReadableFileSize(e.bytes));
    if (e.mtime !== null) parts.push(relativeMtime(e.mtime, listedNowMs));
    return parts.join(" · ");
  }

  // Re-list whenever the path changes. `path` is read synchronously so the
  // effect tracks it; refresh() is fire-and-forget because its own state writes
  // are what the view reads.
  $effect(() => {
    void path;
    refresh();
  });
</script>

<div class="file-browser">
  <div class="file-browser-bar">
    <!-- ROOT CHIPS. The tree genuinely has TWO OR THREE ROOTS at once (in HTTP
         mode documents and assets are server-side while renderings, caches and
         the draft are always in this browser), so there is no single top to
         climb to and the roots are switched rather than navigated. -->
    {#each activeRoots() as r (r.id)}
      <Tooltip text={r.label}>
        <button
          type="button"
          class="btn file-browser-root"
          class:active={parsed.root === r.id}
          aria-pressed={parsed.root === r.id}
          onclick={() => goTo(`${r.id}:/`)}
        >
          <iconify-icon icon={r.icon} width="14" height="14"></iconify-icon>
          {r.label}
        </button>
      </Tooltip>
    {/each}

    <!-- UP uses aria-disabled + a handler guard, not the native attribute: a
         natively-disabled button is not focusable, so a keyboard user could
         never reach the tip explaining why there is nothing above a root. -->
    <Tooltip text={upPath === null ? "Nothing above a root — the roots are separate stores, not folders of one tree" : "Up one level"}>
      <button
        type="button"
        class="btn-icon"
        aria-label="Up one level"
        aria-disabled={upPath === null}
        onclick={() => upPath !== null && goTo(upPath)}
      >
        <iconify-icon icon="mdi:arrow-up" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Home — this project's directory">
      <button type="button" class="btn-icon" aria-label="Home" onclick={() => goTo(homePath(app))}>
        <iconify-icon icon="mdi:home-outline" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Re-read this folder">
      <button type="button" class="btn-icon" aria-label="Refresh" onclick={refresh}>
        <iconify-icon icon="mdi:refresh" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>

    <!-- Fuzzy, by PATH, through the SAME ranker the command palette and the
         Asset Explorer use (core/fuzzy.js) — one app, one idea of what a query
         matches. -->
    <input
      class="file-browser-search"
      type="search"
      placeholder="Filter by path…"
      aria-label="Filter by path"
      bind:value={query}
    />
  </div>

  <nav class="file-browser-crumbs" aria-label="Breadcrumbs">
    {#each crumbs as crumb, i (crumb.path)}
      {#if i > 0}<span class="file-browser-crumb-sep" aria-hidden="true">/</span>{/if}
      <button type="button" class="file-browser-crumb" onclick={() => goTo(crumb.path)}>{crumb.label}</button>
    {/each}
  </nav>

  <!-- A STORE THAT FAILED AND A STORE THAT IS EMPTY MUST NEVER LOOK THE SAME.
       listPath returns its errors rather than catching into [], and they render
       here, above whatever rows did arrive. -->
  {#each errors as err (err.path)}
    <div class="file-browser-notice file-browser-error">
      <iconify-icon icon="mdi:alert-circle-outline" width="16" height="16"></iconify-icon>
      <span>Couldn't read {err.path} — {err.message}</span>
    </div>
  {/each}
  {#if actionError}
    <div class="file-browser-notice file-browser-error">
      <iconify-icon icon="mdi:alert-circle-outline" width="16" height="16"></iconify-icon>
      <span>{actionError}</span>
    </div>
  {/if}

  <div class="file-browser-body">
    <div class="file-browser-list" role="listbox" tabindex="-1" aria-label="Files">
      {#if loading}
        <div class="file-browser-notice">Reading {path}…</div>
      {:else if noMatches}
        <div class="file-browser-notice">Nothing here matches “{query}”.</div>
      {:else if shown.length === 0}
        <div class="file-browser-notice">This folder is empty.</div>
      {:else}
        {#each shown as e (e.path)}
          <Tooltip text={e.note}>
            <div
              class="file-browser-row"
              class:selected={e.path === selectedPath}
              role="option"
              aria-selected={e.path === selectedPath}
              tabindex="0"
              onpointerenter={() => select(e.path)}
              onfocus={() => select(e.path)}
              onclick={() => activate(e)}
              onkeydown={(ev) => ev.key === "Enter" && activate(e)}
            >
              <!-- A ROW SHOWS THE FILE, NOT A GENERIC PAGE GLYPH (R6-19.3: "preview
                   files in it, like the asset explorer does"). It used to draw
                   `entryPresentation(e).icon`, which is null for exactly the two
                   kinds that HAVE a picture — so an image and a video were the only
                   rows in the browser rendered as an anonymous `mdi:file-outline`,
                   while a font got its proper glyph. AssetThumb is the app's ONE
                   thumbnail layer and already dispatches on that presentation;
                   `project` points its URL resolution and its PDF thumbnail-cache
                   write at the keyspace being browsed rather than at the open
                   project, which is the only reason it could not simply be reused
                   before. `url` arrives already resolved from the seam, and
                   resolveUrl is idempotent in both adapters (the local one passes
                   through anything that is not an "/asset/" ref; the HTTP one
                   prefixes a BACKEND that leaves the result no longer starting with
                   "/" unless BACKEND is empty, in which case prefixing is identity). -->
              <div class="file-browser-thumb">
                {#if e.type === "dir"}
                  <iconify-icon icon="mdi:folder-outline" width="18" height="18"></iconify-icon>
                {:else}
                  <!-- .ae-tile is the box AssetThumb's children fill (100%/100%);
                       reused rather than re-declared so a row's media and a grid
                       tile's media are the same thing at two sizes. -->
                  <div class="ae-tile">
                    <AssetThumb {app} asset={e} project={parsed.keyspace} />
                  </div>
                {/if}
              </div>
              <span class="file-browser-name">{e.name}</span>
              {#if e.type === "file"}
                <span class="file-browser-detail">{detailLine(e)}</span>
              {/if}
            </div>
          </Tooltip>
        {/each}
      {/if}
    </div>

    <!-- THE DETAIL PANEL. It always states what backs the selected node (`note`)
         — that sentence is the honest half of the directory illusion, and hiding
         it would make an invented grouping look like a real folder. -->
    <aside class="file-browser-detail-pane">
      {#if selected === null}
        <div class="file-browser-notice">Point at a row to see what it is; click it to preview it.</div>
      {:else}
        <div class="file-browser-detail-name">{selected.name}</div>
        <div class="file-browser-detail-meta">{detailLine(selected)}</div>
        <p class="file-browser-detail-note">{selected.note}</p>
        <div class="file-browser-detail-actions">
          <button type="button" class="btn" onclick={() => loadPreview(selected)}>
            <iconify-icon icon="mdi:eye-outline" width="14" height="14"></iconify-icon>
            Preview
          </button>
          <button type="button" class="btn" onclick={() => download(selected)}>
            <iconify-icon icon="mdi:download" width="14" height="14"></iconify-icon>
            Download
          </button>
        </div>
        <!-- THE PREVIEW SITS ABOVE THE REFUSALS, and that ordering was
             measured rather than guessed: with five long "not done here"
             sentences first, a CSV table opened by a click rendered BELOW the
             fold of the detail pane, so the content the gesture asked for was
             the one thing not on screen. The refusals are context; the preview
             is the answer. -->
        {#if preview}
          <div class="file-browser-preview">
            {#if preview.kind === "image"}
              <img class="file-browser-preview-media" src={preview.url} alt={selected.name} />
            {:else if preview.kind === "video"}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="file-browser-preview-media" src={preview.url} controls></video>
            {:else if selected.kind === "data"}
              <!-- The table gets the WHOLE file (loadPreview's budget), so no
                   truncation sentence belongs here — and that is the point: a
                   peek fed to a table renders a mangled final row that reads as
                   real data. If the budget ever changes, `truncated` is what
                   would have to be surfaced, not hidden. -->
              <CsvTable text={preview.text} filename={selected.name} />
            {:else}
              <pre class="file-browser-preview-text">{preview.text}</pre>
              {#if preview.truncated}
                <!-- SAID, NOT DRAWN INTO THE TEXT. An "…" appended to the string
                     is indistinguishable from an "…" that was in the file. -->
                <p class="file-browser-preview-note">
                  Showing the first {humanReadableFileSize(PREVIEW_TEXT_BYTES)} — download the file to read the rest.
                </p>
              {/if}
            {/if}
          </div>
        {/if}
        <!-- WHAT THIS ROOT DOES NOT DO, stated as SENTENCES rather than as a row
             of greyed-out buttons. That was the first shape and it was wrong twice
             over: the house rule is that "a control that looks clickable but only
             reports is a lie", and buttons labelled with raw operation keys
             ("write", "nest") are not vocabulary a user has ever been taught.
             Each sentence already names its own subject and what to use instead,
             so no second label table is needed — and a label table would be a
             hand-maintained mirror of UNAVAILABLE_HERE's keys, which is the worst
             recurring defect in this codebase. -->
        <div class="file-browser-limits">
          <div class="file-browser-limits-title">Not done here</div>
          <ul class="file-browser-limits-list">
            {#each Object.entries(root.capabilities.unavailable) as [op, why] (op)}
              <li>{why}</li>
            {/each}
          </ul>
        </div>
      {/if}
    </aside>
  </div>
</div>
