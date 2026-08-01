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
  import CsvTable from "./CsvTable.svelte";
  import { humanReadableFileSize } from "./fileSize.js";
  import { relativeMtime } from "./projectPreviews.js";
  import { breadcrumbs, filterEntries, parentPath, parsePath, sortEntries } from "./storagePath.js";
  import { activeRoots, downloadEntry, entryPresentation, homePath, listPath, previewOfBlob, readPath, releasePreview, rootFor } from "./storageTree.js";

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
   *  still there (see refresh). */
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
   *  previous row's object URL. A directory has no preview to load. */
  function select(entryPath) {
    releasePreview(preview);
    preview = null;
    selectedPath = entryPath;
  }

  /** Command (reads bytes; mutates `preview`/`actionError`). Load the selected
   *  file's inline preview. Not automatic on selection: reading a multi-gigabyte
   *  rendering because a row was clicked is exactly the cost this browser should
   *  not impose on a glance. */
  async function loadPreview(e) {
    actionError = null;
    try {
      preview = await previewOfBlob(await readPath(e.path), e.kind);
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

  /** Command (mutates `path` or the selection). A row's primary gesture: a
   *  folder descends, a file selects. Matching the Asset Explorer's split, where
   *  a single click never opens anything. */
  function activate(e) {
    if (e.type === "dir") goTo(e.path);
    else select(e.path === selectedPath ? null : e.path);
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
          {@const pres = entryPresentation(e)}
          <Tooltip text={e.note}>
            <div
              class="file-browser-row"
              class:selected={e.path === selectedPath}
              role="option"
              aria-selected={e.path === selectedPath}
              tabindex="0"
              onclick={() => activate(e)}
              onkeydown={(ev) => ev.key === "Enter" && activate(e)}
            >
              <iconify-icon class="file-browser-glyph" icon={pres.icon ?? "mdi:file-outline"} width="18" height="18"></iconify-icon>
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
        <div class="file-browser-notice">Select a file to see what it is, preview it, or save it.</div>
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
        <!-- The operations this root does NOT perform, each with the sentence
             saying why and what to use instead — a DISABLED affordance carrying
             its reason, never a missing button and never a silent no-op. -->
        <div class="file-browser-detail-actions">
          {#each Object.entries(root.capabilities.unavailable) as [op, why] (op)}
            <Tooltip text={why}>
              <button type="button" class="btn" aria-disabled="true" onclick={() => {}}>{op}</button>
            </Tooltip>
          {/each}
        </div>
        {#if preview}
          <div class="file-browser-preview">
            {#if preview.kind === "image"}
              <img class="file-browser-preview-media" src={preview.url} alt={selected.name} />
            {:else if preview.kind === "video"}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video class="file-browser-preview-media" src={preview.url} controls></video>
            {:else if selected.kind === "data"}
              <CsvTable text={preview.text} filename={selected.name} />
            {:else}
              <pre class="file-browser-preview-text">{preview.text}</pre>
            {/if}
          </div>
        {/if}
      {/if}
    </aside>
  </div>
</div>
