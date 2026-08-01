<!--
  DebugStoragePage — the Debug console's FIRST page (user's concrete ask):
  every file this origin stores, grouped with per-group subtotals and a grand
  total compared against navigator.storage.estimate().

  Reads through the SAME seams the rest of the app uses (web/localDb.js,
  web/storageMode.js's assetStoreFor, web/localRenderStore.js,
  web/debugStorage.js's Cache/indexedDB.databases() readers) rather than
  re-deriving byte counts — a debug tool that disagreed with the app it is
  inspecting would be worse than no debug tool.

  GROUPS (web/debugStorage.js STORAGE_GROUPS, in this fixed order):
    documents · assets · renderings · caches · other
  Each row is sorted BIGGEST FIRST (the whole point is finding the pigs).

  HTTP vs BROWSER-LOCAL is labeled per group, not assumed: in server mode,
  documents/assets live behind HTTP (their sizes still come from the existing
  listing calls) while renderings/caches/other IndexedDB are ALWAYS this
  browser's own storage regardless of storageMode() — a render job and the
  service worker's caches exist independent of where the project itself lives.

  PER-FILE AFFORDANCES (assets + renderings, wherever the bytes are actually
  reachable from this browser): DOWNLOAD mints an objectURL + a[download] and
  revokes it immediately after, matching web/AssetExplorer.svelte's exact
  pattern; PREVIEW shows an inline thumbnail for images, an inline <video> for
  clips, and the first few KB as text for anything the browser can decode as
  UTF-8 — never fetched until the row is expanded, so opening this page never
  pulls every asset's bytes just to draw a list.
-->
<script module>
  import { assetsByKeyspace, documentRowsFromLocalDocs, estimateDeltaLine, gatherCacheRows, gatherOtherDatabaseRows, GROUP_INFO, inventoryReport, KNOWN_DATABASE_NAMES, rowLabel } from "./debugStorage.js";
  import { humanReadableFileSize } from "./fileSize.js";
  import { DOC_STORE, storageBudget, withStore } from "./localDb.js";
  import { listRenderJobs, renderingBlob } from "./localRenderStore.js";
  import { DRAFT_KEY } from "./draftKeys.js";
  import { assetStoreFor, isStatic } from "./storageMode.js";

  /**
   * Query (reads IndexedDB + CacheStorage + the network in HTTP mode). Every
   * row this page needs, gathered from live sources. Kept as a standalone
   * function (rather than inlined in the component) so the browser probe can
   * call it directly without mounting a modal.
   *
   * @param {object} app - the live PowerRPApp
   * @returns {Promise<{rowsByGroup: object, estimate: object}>}
   */
  export async function gatherDebugStorageData(app) {
    const rowsByGroup = { documents: [], assets: [], renderings: [], caches: [], other: [] };
    const projectsSeen = new Set();

    // ── DOCUMENTS ────────────────────────────────────────────────────────────
    // Local (static) mode: every stored doc, read straight out of IndexedDB —
    // the cross-project enumeration no single project-scoped call offers.
    // HTTP mode: the existing project listing (same call the Open modal uses),
    // labeled server-side (bytes: null) since doc.json's size is not part of
    // that listing's reply and duplicating a byte-counting fetch per project
    // just for this debug page is not worth a second network round trip.
    if (isStatic()) {
      const docs = await withStore(DOC_STORE, "readonly", (s) => new Promise((resolve, reject) => {
        const req = s.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error(`DebugStoragePage: reading ${DOC_STORE} — ${req.error?.message ?? "unknown"}`));
      }));
      rowsByGroup.documents = documentRowsFromLocalDocs(docs);
      for (const d of docs) projectsSeen.add(d.name);
    } else {
      const projects = await app.listProjects();
      for (const p of projects) {
        projectsSeen.add(p.name);
        rowsByGroup.documents.push({ name: rowLabel(p.name), bytes: null });
      }
    }
    // The DRAFT keyspace may hold assets with NO document record yet (an
    // opened-but-unsaved draft never writes a project entry — see localDb.js's
    // "no orphan sweep" note) — always probe it explicitly so its bytes are
    // never silently dropped from the inventory.
    projectsSeen.add(DRAFT_KEY);

    // ── ASSETS — per file, grouped by keyspace ──────────────────────────────
    // NEITHER LIST BELOW IS CAUGHT, and the absent-keyspace worry that used to
    // justify catching into [] was never real: both are PREFIX getAlls
    // (assetStore.localAssetStore.list -> getAllByPrefix, localRenderStore.
    // listRenderJobs -> getAll(IDBKeyRange.bound)), and a prefix getAll over a
    // range with no records RESOLVES `[]`. It never rejects. So a catch here
    // could only ever swallow a genuine fault — a broken database, a revoked
    // origin, a server that stopped answering — and turn it into a SMALLER
    // grand total, silently, on the one page whose entire job is to state that
    // total truthfully. `reload()` below already has the loud handler; every
    // other source on this page (the DOC_STORE read, gatherCacheRows,
    // gatherOtherDatabaseRows, storageBudget) already reports through it.
    const assetRows = [];
    for (const projectName of projectsSeen) {
      const assets = await assetStoreFor(projectName).list(projectName);
      for (const a of assets) assetRows.push({ project: projectName, name: a.name, bytes: a.size ?? 0, kind: a.kind });
    }
    rowsByGroup.assets = assetsByKeyspace(assetRows);

    // ── RENDERINGS — always browser-local, in EITHER storage mode ───────────
    for (const projectKey of projectsSeen) {
      const jobs = await listRenderJobs(projectKey);
      for (const job of jobs) rowsByGroup.renderings.push({ project: projectKey, name: `${rowLabel(projectKey)} / ${job.name}`, jobId: job.id, bytes: job.bytes ?? 0, state: job.state });
    }

    // ── CACHES + OTHER INDEXEDDB — always browser-local ─────────────────────
    rowsByGroup.caches = await gatherCacheRows();
    rowsByGroup.other = await gatherOtherDatabaseRows(KNOWN_DATABASE_NAMES);

    const estimate = await storageBudget();
    return { rowsByGroup, estimate };
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { app } = $props();

  // A preview is a PEEK, not a second copy of a multi-MB asset held in
  // component state. Module-top per core/endpoints.js:23's precedent.
  const PREVIEW_TEXT_BYTES = 4096;

  let loading = $state(true);
  /** The one visible error line, for BOTH a failed gather and a failed row
   *  action — AssetExplorer.svelte keeps a single `error` the same way. It
   *  renders ABOVE the inventory rather than instead of it, so a download that
   *  failed says so without throwing away the list the user is reading. */
  let error = $state(null);
  let report = $state(null);
  let estimate = $state(null);
  let assetKeyspaces = $state([]); // debugStorage.assetsByKeyspace() output, biggest keyspace first
  /** Which caches' per-entry detail is expanded — folded by default (user
   *  ruling: "since 159 shell entries is noise most of the time"). */
  let expandedCaches = $state(new Set());
  /** Row key ("project/file") -> {kind, url|text}. Populated lazily on preview click. */
  let previews = $state({});

  /** Command (mutates this component's state; reads every storage seam).
   *  Re-gather the whole inventory and rebuild the report. */
  async function reload() {
    loading = true;
    error = null;
    previews = {};
    try {
      const { rowsByGroup, estimate: est } = await gatherDebugStorageData(app);
      // The Assets group's SUBTOTAL rows (what inventoryReport sorts and sums)
      // are one row per keyspace; the individual files inside each keyspace are
      // kept separately in assetKeyspaces for the per-file affordances below.
      const keyspaceRows = rowsByGroup.assets.map((k) => ({ name: `${rowLabel(k.project)} — ${k.files.length} file${k.files.length === 1 ? "" : "s"}`, bytes: k.bytes }));
      report = inventoryReport({ ...rowsByGroup, assets: keyspaceRows });
      assetKeyspaces = [...rowsByGroup.assets].sort((a, b) => b.bytes - a.bytes);
      estimate = est;
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("DebugStoragePage: could not gather storage inventory:", e);
    } finally {
      loading = false;
    }
  }
  reload();

  /** Command (mutates `expandedCaches`). Fold or unfold one cache's per-entry
   *  detail. A NEW Set each time, because Svelte 5 tracks the reference. */
  function toggleCache(name) {
    const next = new Set(expandedCaches);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    expandedCaches = next;
  }

  /**
   * Pure function. The `previews` map key for one file. Joined on NUL, the one
   * byte a project name cannot contain (draftKeys.validProjectName rejects it,
   * mirroring server.py's _SAFE_NAME), so no two files can collide on it.
   *
   * @param {string} project - keyspace / project name
   * @param {string} name - the file's basename
   * @returns {string}
   *
   * @example rowKey("RobotSim", "arm.png") // "RobotSim\0arm.png"
   */
  function rowKey(project, name) {
    return `${project}\0${name}`;
  }

  /** Command (downloads a file; mutates `error`). Save one asset's bytes to
   *  disk — the exact objectURL + a[download] + revoke pattern
   *  web/AssetExplorer.svelte's downloadAsset uses, so a debug download and a
   *  library download behave identically, INCLUDING the failure: the sentence
   *  lands on the pane's own error line as well as the console, because a
   *  download that did not happen must never look like one that did. */
  async function downloadAsset(project, name) {
    error = null;
    try {
      const blob = await assetStoreFor(project).get(project, name);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      error = `Couldn't download "${rowLabel(project)} / ${name}" — ${e?.message ?? e}`;
      console.error(`DebugStoragePage: could not download "${project}/${name}":`, e);
    }
  }

  /** Command (downloads a file; mutates `error`). The renderings twin of
   *  downloadAsset — reads through localRenderStore.renderingBlob, the same
   *  seam the Render Center modal's own download button uses, and reports a
   *  failure the same visible way. */
  async function downloadRendering(project, jobId, name) {
    error = null;
    try {
      const blob = await renderingBlob(project, jobId);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      error = `Couldn't download the rendering "${name}" — ${e?.message ?? e}`;
      console.error(`DebugStoragePage: could not download rendering "${project}/${jobId}":`, e);
    }
  }

  /** Command (mutates `previews`; may fetch bytes). Toggle an inline preview
   *  for one asset row. Images/video get an objectURL (revoked when the
   *  preview closes); anything else is read as UTF-8 text, TRUNCATED to a
   *  small prefix — a preview is a peek, not a second copy of a multi-MB
   *  asset sitting in component state. */
  async function togglePreview(project, name, kind) {
    const key = rowKey(project, name);
    if (previews[key]) {
      if (previews[key].url) URL.revokeObjectURL(previews[key].url);
      const next = { ...previews };
      delete next[key];
      previews = next;
      return;
    }
    try {
      const blob = await assetStoreFor(project).get(project, name);
      if (kind === "image" || kind === "video") {
        previews = { ...previews, [key]: { kind, url: URL.createObjectURL(blob) } };
      } else {
        const text = await blob.slice(0, PREVIEW_TEXT_BYTES).text();
        previews = { ...previews, [key]: { kind: "text", text: text + (blob.size > PREVIEW_TEXT_BYTES ? "\n…" : "") } };
      }
    } catch (e) {
      previews = { ...previews, [key]: { kind: "error", text: String(e?.message ?? e) } };
    }
  }

  const deltaLine = $derived(report ? estimateDeltaLine(report.grandTotal, estimate, humanReadableFileSize) : "");
</script>

<div class="debug-storage">
  <!-- The error line is NOT in the loading/report chain: a gather failure still
       leaves it alone on the page (report is null), while a row action that
       failed reports ABOVE the inventory instead of erasing it. -->
  {#if error}
    <div class="debug-storage-status debug-storage-error">
      <iconify-icon icon="mdi:alert-circle-outline" width="16" height="16"></iconify-icon>
      {error}
    </div>
  {/if}
  {#if loading}
    <div class="debug-storage-status">Gathering storage inventory…</div>
  {:else if report}
    <div class="debug-storage-header">
      <div class="debug-storage-grandtotal">
        Grand total: <strong>{humanReadableFileSize(report.grandTotal)}</strong>
      </div>
      <div class="debug-storage-delta">{deltaLine}</div>
      <button type="button" class="btn" onclick={reload}>
        <iconify-icon icon="mdi:refresh" width="14" height="14"></iconify-icon>
        Refresh
      </button>
    </div>

    {#each report.groups as group (group.id)}
      <section class="debug-storage-group">
        <Tooltip text={GROUP_INFO[group.id].help}>
          <h3 class="debug-storage-group-title">
            {GROUP_INFO[group.id].title}
            <span class="debug-storage-subtotal">{humanReadableFileSize(group.rows.reduce((s, r) => s + (r.bytes ?? 0), 0))}</span>
          </h3>
        </Tooltip>

        {#if group.id === "assets"}
          {#if assetKeyspaces.length === 0}
            <div class="debug-storage-empty">Nothing here.</div>
          {:else}
            {#each assetKeyspaces as keyspace (keyspace.project)}
              <div class="debug-storage-keyspace">
                <div class="debug-storage-keyspace-title">
                  {rowLabel(keyspace.project)}
                  <span class="debug-storage-row-bytes">{humanReadableFileSize(keyspace.bytes)}</span>
                </div>
                {#each keyspace.files as file (file.name)}
                  {@const key = rowKey(keyspace.project, file.name)}
                  <div class="debug-storage-row debug-storage-row-file">
                    <span class="debug-storage-row-name">{file.name}</span>
                    <span class="debug-storage-row-bytes">{humanReadableFileSize(file.bytes)}</span>
                    <button type="button" class="btn-icon" aria-label={`Preview ${file.name}`} onclick={() => togglePreview(keyspace.project, file.name, file.kind)}>
                      <iconify-icon icon="mdi:eye-outline" width="14" height="14"></iconify-icon>
                    </button>
                    <button type="button" class="btn-icon" aria-label={`Download ${file.name}`} onclick={() => downloadAsset(keyspace.project, file.name)}>
                      <iconify-icon icon="mdi:download" width="14" height="14"></iconify-icon>
                    </button>
                  </div>
                  {#if previews[key]}
                    <div class="debug-storage-preview">
                      {#if previews[key].kind === "image"}
                        <img src={previews[key].url} alt={file.name} class="debug-storage-preview-image" />
                      {:else if previews[key].kind === "video"}
                        <!-- No caption track exists for an arbitrary uploaded asset —
                             this satisfies the a11y lint with an explicit, honest
                             "none available" rather than fabricating one. -->
                        <video src={previews[key].url} controls class="debug-storage-preview-video">
                          <track kind="captions" />
                        </video>
                      {:else if previews[key].kind === "error"}
                        <div class="debug-storage-error">{previews[key].text}</div>
                      {:else}
                        <pre class="debug-storage-preview-text">{previews[key].text}</pre>
                      {/if}
                    </div>
                  {/if}
                {/each}
              </div>
            {/each}
          {/if}
        {:else if group.id === "caches"}
          {#if group.rows.length === 0}
            <div class="debug-storage-empty">Nothing here.</div>
          {/if}
          {#each group.rows as cache (cache.name)}
            <div class="debug-storage-row">
              <button type="button" class="debug-storage-fold" onclick={() => toggleCache(cache.name)}>
                <iconify-icon icon={expandedCaches.has(cache.name) ? "mdi:chevron-down" : "mdi:chevron-right"} width="14" height="14"></iconify-icon>
                <span class="debug-storage-row-name">{cache.name}</span>
                <span class="debug-storage-row-meta">{cache.entries.length} entries</span>
                <span class="debug-storage-row-bytes">{humanReadableFileSize(cache.bytes)}</span>
              </button>
              {#if expandedCaches.has(cache.name)}
                <div class="debug-storage-cache-entries">
                  {#each cache.entries as entry (entry.url)}
                    <div class="debug-storage-cache-entry">
                      <span class="debug-storage-cache-url">{entry.url}</span>
                      <span class="debug-storage-row-bytes">{humanReadableFileSize(entry.bytes)}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {:else if group.id === "renderings"}
          {#if group.rows.length === 0}
            <div class="debug-storage-empty">Nothing here.</div>
          {/if}
          {#each group.rows as row (row.name)}
            <div class="debug-storage-row debug-storage-row-file">
              <span class="debug-storage-row-name">{row.name}</span>
              <span class="debug-storage-row-bytes">{humanReadableFileSize(row.bytes)}</span>
              {#if row.state === "done"}
                <button type="button" class="btn-icon" aria-label={`Download ${row.name}`} onclick={() => downloadRendering(row.project, row.jobId, `${row.name}.mp4`)}>
                  <iconify-icon icon="mdi:download" width="14" height="14"></iconify-icon>
                </button>
              {/if}
            </div>
          {/each}
        {:else}
          {#if group.rows.length === 0}
            <div class="debug-storage-empty">Nothing here.</div>
          {/if}
          {#each group.rows as row (row.name)}
            <div class="debug-storage-row debug-storage-row-plain">
              <span class="debug-storage-row-name">{row.name}</span>
              <span class="debug-storage-row-bytes">{row.bytes === null ? "server-side" : humanReadableFileSize(row.bytes)}</span>
            </div>
          {/each}
        {/if}
      </section>
    {/each}
  {/if}
</div>
