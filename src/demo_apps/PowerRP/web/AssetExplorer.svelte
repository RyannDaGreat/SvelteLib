<!--
  AssetExplorer — the ASSET LIBRARY pane (manifest Round 12/12B), living BELOW
  the Slide Navigator in the left column. Lists the CURRENT project's assets
  from the server; the assets/ folder on disk is the SOURCE OF TRUTH (a manual
  file drop appears here on Refresh).

  - Thumbnail grid (SvelteLib Thumbnail): images render a real thumbnail from
    their served URL; videos/sounds have no still, so they show a kind ICON.
  - REFRESH re-lists (manual folder drops must be discoverable).
  - UPLOAD ASSET (file input → app.uploadAsset) adds a file to the project.
  - Dragging a file from the OS onto THIS PANE uploads it (the pane's own drop
    handler — the CANVAS drag-drop is a DIFFERENT surface owned elsewhere).
  - Double-click an asset → a Modal preview (img / video / audio playback).
  - Image assets carry an "insert into slide" affordance → app.insertImageAsset.
  - DRAG a tile onto the canvas → insert at the drop point (Round 12C). The
    tile sets the ASSET_DRAG_MIME payload; CanvasView owns the drop side.
  - TRASH CAN on tile hover (bottom-right) deletes the asset (Round 12C). If
    the document has USERS of the asset, a confirm Modal lists them — clicking
    a listed user SELECTS it (Property Panel opens on it; explicitly NOT
    navigate-to-slide, which the user retracted) — and Delete still deletes.
  - No project loaded / server down: a loud caption + the error (never a
    silently-empty pane).

  Chrome per house rules: NO <style> block (all classes in app.css via --a-*
  tokens), square corners, iconify glyphs only, SvelteLib Tooltip for hover
  help. The wrapping Panel (App.svelte) owns the region name + scroll body.
-->
<script module>
  import { humanReadableFileSize } from "./fileSize.js";

  /**
   * Pure function. Integer percent of a pending upload (0–100), or null when the
   * total is unknown (0) — the caller shows an INDETERMINATE state instead of
   * dividing by zero. Clamped so a browser reporting loaded>total never overruns.
   *
   * @param {number} loaded - bytes sent so far
   * @param {number} total - total bytes (0 = unknown)
   * @returns {number|null}
   *
   * @example uploadPercent(0, 100)      // 0
   * @example uploadPercent(45, 100)     // 45
   * @example uploadPercent(12300000, 27100000) // 45
   * @example uploadPercent(120, 100)    // 100  (clamped)
   * @example uploadPercent(50, 0)       // null (total unknown → indeterminate)
   */
  export function uploadPercent(loaded, total) {
    return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
  }

  /**
   * Pure function. The overlay caption for a pending upload: determinate shows
   * "45% · 11.7MB / 25.8MB" (percent · bytes-sent / total, sizes via rp-faithful
   * humanReadableFileSize); indeterminate (total unknown) shows just the bytes
   * sent so far — never a NaN% or a divide-by-zero.
   *
   * @param {number} loaded - bytes sent so far
   * @param {number} total - total bytes (0 = unknown)
   * @returns {string}
   *
   * @example uploadCaption(12300000, 27100000) // "45% · 11.7MB / 25.8MB"
   * @example uploadCaption(0, 27100000)        // "0% · 0B / 25.8MB"
   * @example uploadCaption(12300000, 0)        // "11.7MB"  (total unknown)
   */
  export function uploadCaption(loaded, total) {
    const pct = uploadPercent(loaded, total);
    if (pct === null) return humanReadableFileSize(loaded);
    return `${pct}% · ${humanReadableFileSize(loaded)} / ${humanReadableFileSize(total)}`;
  }

  /**
   * Pure function. Every item in the document that REFERENCES the given asset:
   * any slide's delta setting the item's `src` to the asset's served path
   * (image/video widgets store the url) or bare filename (filmstrips), or
   * holding filmstrip `frameUrls` extracted from it. Purged items never appear
   * (purge removes an item's delta entries entirely). Returns [{id, type,
   * name}] in first-reference order; type/name accumulate across deltas (an
   * item's type lives only in its creation delta; the freshest name wins).
   *
   * @example
   * // A video widget sourcing the asset by URL is a user:
   * // assetUsers({slides: [{delta: {items: {v1: {type: "video", src: "/asset/P/clip.mp4"}}}}]},
   * //            "clip.mp4", "/asset/P/clip.mp4")  // => [{id: "v1", type: "video", name: undefined}]
   * @example
   * // A filmstrip stores the bare FILENAME; a rect never matches:
   * // assetUsers({slides: [{delta: {items: {f1: {type: "filmstrip", src: "clip.mp4"}, r1: {type: "rect"}}}}]},
   * //            "clip.mp4", "/asset/P/clip.mp4")  // => [{id: "f1", type: "filmstrip", name: undefined}]
   * @example
   * // assetUsers({slides: [{delta: {}}]}, "x.png", "/asset/P/x.png")  // => []
   */
  export function assetUsers(doc, assetName, assetPath) {
    const meta = new Map(); // id → {type, name} accumulated across all deltas
    const refs = new Set(); // ids that reference the asset in ANY delta
    for (const slide of doc.slides ?? []) {
      for (const [id, it] of Object.entries(slide.delta?.items ?? {})) {
        const m = meta.get(id) ?? { type: undefined, name: undefined };
        if (typeof it.type === "string") m.type = it.type;
        if (typeof it.name === "string") m.name = it.name;
        meta.set(id, m);
        const src = typeof it.src === "string" ? it.src : "";
        if (
          (src && (src.includes(assetPath) || src === assetName)) ||
          (Array.isArray(it.frameUrls) &&
            it.frameUrls.some((u) => decodeURIComponent(u).includes(`/frames/${assetName}/`)))
        )
          refs.add(id);
      }
    }
    return [...refs].map((id) => ({ id, ...meta.get(id) }));
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Modal from "../../../lib/Modal.svelte";
  import AssetThumb from "./AssetThumb.svelte";
  import { KIND_ICON } from "./assetThumbnail.js";
  import { assetUrl, ASSET_DRAG_MIME } from "./projectApi.js";
  import { copyText } from "./clipboard.js";

  let { app } = $props();

  // Asset list state. `assets` null = not-yet-loaded; [] = loaded-but-empty.
  // `error` holds the loud failure message (no project / server down) — the
  // pane shows it instead of pretending it's empty.
  let assets = $state(null);
  let error = $state(null);
  let loading = $state(false);
  let dragging = $state(false); // OS file dragged over the pane
  let uploading = $state(false);
  let preview = $state(null); // {name, kind, url} being previewed in the Modal
  let previewOpen = $state(false);

  // How long the copy-path button flashes its "Copied!" check after a
  // successful copy; `justCopiedUrl` is the asset URL currently flashing (null
  // = none). Mirrors the Inspector's copy-path feedback.
  const COPY_FLASH_MS = 1200;
  let justCopiedUrl = $state(null);
  // Pending delete-with-users confirmation: {asset, users} or null (Round 12C:
  // deleting an asset the document references asks first, listing the users).
  let confirmDelete = $state(null);
  let confirmOpen = $state(false);
  let fileInput; // hidden <input type=file> for the Upload button

  /** Query. Absolute (proxy-aware) URL for an asset's served path. */
  function urlOf(a) {
    return assetUrl(a.url);
  }

  /**
   * Command. (Re)loads the current project's asset list from the server.
   * A failure is reported LOUDLY IN THE PANE — the visible `error` notice is
   * the user-facing report (never a silently-empty pane) — AND to the console.
   * Listing a project that has never been saved is NOT a failure: the server's
   * list_assets() returns `[]` (200 OK) for a folder that doesn't exist yet
   * (server/server.py), so an unsaved "Untitled" project boots straight to the
   * empty-state notice, never the red error — only a genuine network/backend
   * failure (the server not running at all) reaches the catch below.
   */
  async function refresh() {
    loading = true;
    error = null;
    try {
      assets = await app.listProjectAssets();
      // A finished ("done") optimistic tile is dropped here — once, and only
      // once its REAL tile is present in this fresh listing — so the swap has
      // no flicker gap (see app.reconcileUploads).
      app.reconcileUploads(assets);
      // Register any FONT assets as selectable families (#26) — a manual folder
      // drop or a returning project must offer its uploaded fonts in the dropdown.
      app.registerFontAssets(assets);
    } catch (e) {
      error = String(e?.message ?? e);
      assets = null;
      console.error("AssetExplorer: could not list project assets:", e);
    } finally {
      loading = false;
    }
  }

  // Re-list on MOUNT (manifest "ASSET UX ROUND 2": "the asset browser should
  // refresh on page load of course" — no stale "Couldn't load assets" until a
  // manual action), whenever the PROJECT IDENTITY changes (Open/Load/Clear
  // swaps the folder), and whenever ANY asset lands/leaves (app.assetsVersion
  // bumps on every upload/delete — including a canvas OS-file drop, which must
  // appear here without a manual Refresh).
  //
  // Keyed on the VALUE pair, not reactive identity: projectName() reads
  // app.doc, whose object identity flips on EVERY commit (any canvas edit) —
  // without the key guard each commit would re-list the assets (a network
  // call + the grid flashing through its loading notice).
  let lastListedKey = null;
  $effect(() => {
    const key = `${app.projectName()}|${app.assetsVersion}`;
    if (key === lastListedKey) return;
    lastListedKey = key;
    refresh();
  });

  /** Command. Uploads one or more Files to the project. The list refreshes via
   *  the assetsVersion effect above (one refresh pathway for uploads from this
   *  pane AND from canvas drops). Errors surface loudly. */
  async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    uploading = true;
    error = null;
    try {
      for (const file of files) await app.uploadAsset(file);
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("AssetExplorer: upload failed:", e);
    } finally {
      uploading = false;
    }
  }

  function onUploadClick() {
    fileInput.value = ""; // let re-picking the same file fire onchange again
    fileInput.click();
  }
  function onFileChosen(e) {
    uploadFiles([...e.currentTarget.files]);
  }

  // ── Pane drag-drop upload (THIS pane only; the canvas is a separate surface) ─
  function onDragOver(e) {
    if (![...e.dataTransfer.types].includes("Files")) return; // ignore non-file drags
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dragging = true;
  }
  function onDragLeave(e) {
    // Only clear when the pointer actually left the pane (not a child boundary).
    if (e.currentTarget.contains(e.relatedTarget)) return;
    dragging = false;
  }
  function onDrop(e) {
    e.preventDefault();
    dragging = false;
    uploadFiles([...e.dataTransfer.files]);
  }

  /** Command. Opens the Modal preview for an asset. */
  function openPreview(a) {
    preview = a;
    previewOpen = true;
  }

  /** Command. Inserts an image asset onto the current slide (native size,
   *  centered in the camera view — the app resolves the served path). Errors
   *  surface loudly. */
  async function insert(a) {
    try {
      await app.insertImageAsset(a.url);
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("AssetExplorer: insert failed:", e);
    }
  }

  /** Command. Starts an asset-tile drag: the payload CanvasView's drop handler
   *  reads to insert the asset at the drop point (Round 12C). */
  function onTileDragStart(e, a) {
    e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify({ name: a.name, kind: a.kind, url: a.url }));
    e.dataTransfer.effectAllowed = "copy";
  }

  /** Command. Copies an asset's served path (the project-relative URL every
   *  widget stores as `src`, e.g. "/asset/MyTalk/clip.mp4") to the system
   *  clipboard (manifest "ASSET UX ROUND 2": "there should be a copy path
   *  option on the assets") via the shared clipboard helper (web/clipboard.js:
   *  secure-context writeText, else an execCommand fallback that works over
   *  plain HTTP — the fix for the unguarded navigator.clipboard call that threw
   *  on a non-localhost origin). ON SUCCESS the button flashes a
   *  "Copied!" check; a genuine failure is reported LOUDLY inside the helper. */
  async function copyAssetPath(a) {
    if (await copyText(a.url, "asset path")) {
      justCopiedUrl = a.url;
      setTimeout(() => { if (justCopiedUrl === a.url) justCopiedUrl = null; }, COPY_FLASH_MS);
    }
  }

  /** Display label for a using item — the Inspector picker's convention:
   *  authored name, else "<Type> (id-prefix)". */
  function userLabel(u) {
    return u.name ?? `${app.registry.get(u.type)?.title ?? u.type} (${u.id.slice(0, 4)})`;
  }

  /** Command. Trash-can click: delete immediately when nothing references the
   *  asset; otherwise ask first, listing the users (Round 12C). */
  function onTrashClick(a) {
    const users = assetUsers(app.doc, a.name, a.url);
    if (users.length === 0) return doDelete(a);
    confirmDelete = { asset: a, users };
    confirmOpen = true;
  }

  /** Command. Deletes the asset server-side (the assetsVersion effect
   *  re-lists). Errors surface loudly in the pane and the console. */
  async function doDelete(a) {
    try {
      await app.deleteProjectAsset(a.name);
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("AssetExplorer: delete failed:", e);
    }
  }

  /** Command. Clicking a listed user SELECTS it — the Property Panel opens on
   *  it (the picker already handles not-visible selection; explicitly NOT
   *  navigate-to-slide, which the user retracted). Closes the modal so the
   *  now-open Property Panel is actually visible behind it. */
  function selectUser(u) {
    app.selection = u.id;
    confirmOpen = false;
  }

  /** Command. Confirmed delete-with-users: close the modal and delete. */
  function confirmDeleteNow() {
    confirmOpen = false;
    doDelete(confirmDelete.asset);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="asset-explorer"
  class:dragging
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <div class="ae-actions">
    <Tooltip text="Refresh (pick up manual folder drops)">
      <button class="btn-icon" aria-label="Refresh assets" onclick={refresh} disabled={loading}>
        <iconify-icon icon="mdi:refresh" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <Tooltip text="Upload asset to this project">
      <button class="btn-icon" aria-label="Upload asset" onclick={onUploadClick} disabled={uploading}>
        <iconify-icon icon="mdi:upload" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <!-- Hidden file input drives the Upload button. -->
    <input class="ae-file" type="file" multiple bind:this={fileInput} onchange={onFileChosen} />
  </div>

  <div class="ae-body">
    <!-- OPTIMISTIC UPLOAD TILES — always first, above the real grid. Each shows
         a live percent + bytes overlay (uploadCaption); a failed upload becomes
         a loud, dismissible error tile (never a swallowed failure). They appear
         the instant uploadAsset is called and survive the post-upload re-list's
         loading state (which is why they render OUTSIDE the error/loading/empty
         chain below). -->
    {#if app.uploads.length}
      <div class="ae-grid ae-uploads-grid">
        {#each app.uploads as u (u.id)}
          <div class="ae-cell">
            <div class="ae-tile ae-upload" class:ae-upload-failed={u.status === "error"}>
              <div class="ae-kind" aria-hidden="true">
                <iconify-icon icon={KIND_ICON[u.kind] ?? "mdi:file-outline"} width="28" height="28"></iconify-icon>
              </div>
              {#if u.status === "error"}
                <div class="ae-upload-overlay ae-upload-overlay-error">
                  <iconify-icon icon="mdi:alert-circle-outline" width="20" height="20"></iconify-icon>
                  <div class="ae-upload-caption">Upload failed</div>
                </div>
                <Tooltip text={u.error}>
                  <button class="btn-icon ae-upload-dismiss" aria-label={`Dismiss failed upload ${u.name}`} onclick={() => app.dismissUpload(u.id)}>
                    <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
                  </button>
                </Tooltip>
              {:else}
                <div class="ae-upload-overlay">
                  {#if uploadPercent(u.loaded, u.total) === null}
                    <div class="ae-upload-spinner" aria-label="Uploading"></div>
                  {:else}
                    <div class="ae-upload-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={uploadPercent(u.loaded, u.total)}>
                      <div class="ae-upload-bar-fill" style={`--ae-upload-fill:${uploadPercent(u.loaded, u.total)}%`}></div>
                    </div>
                  {/if}
                  <div class="ae-upload-caption">{uploadCaption(u.loaded, u.total)}</div>
                </div>
              {/if}
            </div>
            <div class="ae-name">{u.name}</div>
          </div>
        {/each}
      </div>
    {/if}

    {#if error}
      <div class="ae-notice ae-error">
        <div class="ae-notice-title">Couldn't load assets</div>
        <div class="ae-notice-detail">{error}</div>
      </div>
    {:else if app.uploads.length}
      <!-- Uploads in flight: keep the real tiles visible UNDER the pending tiles
           (no grid flash to a loading notice during the re-list) so a done tile
           resolves smoothly into its real neighbor. Nothing extra when there are
           no real assets yet — the pending tiles above already fill the pane. -->
      {#if assets && assets.length > 0}{@render assetGrid()}{/if}
    {:else if loading}
      <div class="ae-notice">Loading assets…</div>
    {:else if assets === null}
      <!-- Transient: the mount/project-switch effect's refresh() hasn't resolved
           yet (assets load automatically — see the $effect above). -->
      <div class="ae-notice">Loading assets for “{app.projectName()}”…</div>
    {:else if assets.length === 0}
      <div class="ae-notice">
        No assets yet — Upload, or drop a file onto this pane.
      </div>
    {:else}
      {@render assetGrid()}
    {/if}
  </div>

  {#snippet assetGrid()}
      <div class="ae-grid">
        {#each assets as a (a.name)}
          <div class="ae-cell">
            <Tooltip text={`${a.name} (${a.kind}) — drag onto the canvas to insert at a point`}>
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="ae-tile" draggable="true" ondragstart={(e) => onTileDragStart(e, a)}>
                <!-- Generalized tile media + badge (manifest #25): image/video
                     real thumbnails, a cached-or-rasterized PDF first-page preview
                     with a page-count badge, else the kind glyph. See AssetThumb /
                     assetThumbnail.js. onclick is a no-op (double-click below owns
                     the preview open). -->
                <AssetThumb {app} asset={a} onclick={() => {}} />
                <!-- Double-click opens the Modal preview (whole tile is the target). -->
                <button
                  class="ae-tile-hit"
                  aria-label={`Preview ${a.name}`}
                  ondblclick={() => openPreview(a)}
                ></button>
                {#if a.kind === "image"}
                  <Tooltip text="Insert into current slide">
                    <button
                      class="btn-icon ae-insert"
                      aria-label={`Insert ${a.name} into slide`}
                      onclick={() => insert(a)}
                    >
                      <iconify-icon icon="mdi:image-plus-outline" width="14" height="14"></iconify-icon>
                    </button>
                  </Tooltip>
                {/if}
                <Tooltip text={justCopiedUrl === a.url ? "Copied!" : "Copy served path to clipboard"}>
                  <button
                    class="btn-icon ae-copy-path"
                    aria-label={justCopiedUrl === a.url ? `Copied path for ${a.name}` : `Copy path for ${a.name}`}
                    onclick={() => copyAssetPath(a)}
                  >
                    <iconify-icon icon={justCopiedUrl === a.url ? "mdi:check" : "mdi:content-copy"} width="14" height="14"></iconify-icon>
                  </button>
                </Tooltip>
                <Tooltip text="Delete asset from the project">
                  <button
                    class="btn-icon ae-trash"
                    aria-label={`Delete ${a.name}`}
                    onclick={() => onTrashClick(a)}
                  >
                    <iconify-icon icon="mdi:trash-can-outline" width="14" height="14"></iconify-icon>
                  </button>
                </Tooltip>
              </div>
            </Tooltip>
            <div class="ae-name">{a.name}</div>
          </div>
        {/each}
      </div>
  {/snippet}
</div>

<Modal bind:open={previewOpen} title={preview?.name ?? ""}>
  {#if preview?.kind === "image"}
    <img class="ae-preview-media" src={urlOf(preview)} alt={preview.name} />
  {:else if preview?.kind === "video"}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="ae-preview-media" src={urlOf(preview)} controls autoplay></video>
  {:else if preview?.kind === "sound"}
    <audio class="ae-preview-media" src={urlOf(preview)} controls autoplay></audio>
  {/if}
</Modal>

<!-- Delete-with-users confirmation (Round 12C). The message is the user's
     spec verbatim; each row selects its widget (Property Panel opens on it). -->
<Modal bind:open={confirmOpen} title="Delete asset?">
  {#if confirmDelete}
    <div class="ae-confirm-msg">There's a user of this asset. Are you sure you want to delete?</div>
    <div class="ae-confirm-sub">
      “{confirmDelete.asset.name}” is used by — click one to inspect it:
    </div>
    <ul class="ae-users">
      {#each confirmDelete.users as u (u.id)}
        <li>
          <button type="button" class="btn ae-user-row" onclick={() => selectUser(u)}>
            {userLabel(u)}
          </button>
        </li>
      {/each}
    </ul>
    <div class="ae-confirm-actions">
      <button type="button" class="btn danger" onclick={confirmDeleteNow}>Delete</button>
      <button type="button" class="btn" onclick={() => (confirmOpen = false)}>Cancel</button>
    </div>
  {/if}
</Modal>
