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
  - No project loaded / server down: a loud caption + the error (never a
    silently-empty pane).

  Chrome per house rules: NO <style> block (all classes in app.css via --a-*
  tokens), square corners, iconify glyphs only, SvelteLib Tooltip for hover
  help. The wrapping Panel (App.svelte) owns the region name + scroll body.
-->
<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Thumbnail from "../../../lib/Thumbnail.svelte";
  import Modal from "../../../lib/Modal.svelte";
  import { assetUrl } from "./projectApi.js";

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
  let fileInput; // hidden <input type=file> for the Upload button
  // Whether the pane has ever successfully listed (or been asked to). Gates the
  // project-name effect: a fresh boot does NOT auto-fetch (an unsaved "Untitled"
  // project has no server folder yet — listing it would fail against a possibly-
  // down backend and is pointless). The user's first Refresh, or a Save/Open,
  // activates the pane; from then on a project switch re-lists automatically.
  let activated = false;

  // Per-kind fallback icon for assets with no still image (video/sound), and
  // the small corner badge marking the kind. iconify only (manifest rule).
  const KIND_ICON = { video: "mdi:play-circle-outline", sound: "mdi:music-note", image: "mdi:image-outline" };

  /** Query. Absolute (proxy-aware) URL for an asset's served path. */
  function urlOf(a) {
    return assetUrl(a.url);
  }

  /**
   * Command. (Re)loads the current project's asset list from the server.
   * A failure (server down / no project) is reported LOUDLY IN THE PANE — the
   * visible `error` notice is the user-facing report (never a silently-empty
   * pane). Console severity depends on WHO asked: an explicit user action
   * (Refresh/Upload) logs console.error; the background auto-load at boot logs
   * console.warn, because "the server isn't up yet" is an expected condition
   * for this pane (manifest: "server down / no project loaded"), and the pane
   * notice already surfaces it — spamming console.error at boot would be noise.
   */
  async function refresh() {
    activated = true;
    loading = true;
    error = null;
    try {
      assets = await app.listProjectAssets();
    } catch (e) {
      error = String(e?.message ?? e);
      assets = null;
      console.error("AssetExplorer: could not list project assets:", e);
    } finally {
      loading = false;
    }
  }

  // Re-list when the PROJECT IDENTITY changes (Open/Load/Clear swaps the folder)
  // — but ONLY once the pane has been activated (see `activated`): a fresh boot
  // does not fetch, because an unsaved "Untitled" project has no server folder
  // and the backend may not even be up (manifest: "server down / no project
  // loaded" → the pane shows a caption, not an error). The first Refresh (or a
  // Save/Open, which also touches the server) activates it; thereafter a project
  // switch re-lists automatically.
  $effect(() => {
    app.projectName(); // dependency: fire on project-identity change
    if (activated) refresh();
  });

  /** Command. Uploads one or more Files to the project, then refreshes the
   *  list so the new asset(s) appear. Errors surface loudly. */
  async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    uploading = true;
    error = null;
    try {
      for (const file of files) await app.uploadAsset(file);
      await refresh();
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
   *  centered in the camera view). Errors surface loudly. */
  async function insert(a) {
    try {
      await app.insertImageAsset(urlOf(a));
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("AssetExplorer: insert failed:", e);
    }
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
    {#if error}
      <div class="ae-notice ae-error">
        <div class="ae-notice-title">Couldn't load assets</div>
        <div class="ae-notice-detail">{error}</div>
      </div>
    {:else if loading}
      <div class="ae-notice">Loading assets…</div>
    {:else if assets === null}
      <div class="ae-notice">
        Assets for “{app.projectName()}” load on Refresh (or when you Save/Open a
        project). Upload a file or drop one onto this pane to add it.
      </div>
    {:else if assets.length === 0}
      <div class="ae-notice">
        No assets yet — Upload, or drop a file onto this pane.
      </div>
    {:else}
      <div class="ae-grid">
        {#each assets as a (a.name)}
          <div class="ae-cell">
            <Tooltip text={`${a.name} (${a.kind})`}>
              <div class="ae-tile">
                <Thumbnail
                  src={a.kind === "image" ? urlOf(a) : ""}
                  title=""
                  onclick={() => {}}
                />
                {#if a.kind !== "image"}
                  <div class="ae-kind" aria-hidden="true">
                    <iconify-icon icon={KIND_ICON[a.kind] ?? "mdi:file-outline"} width="28" height="28"></iconify-icon>
                  </div>
                {/if}
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
              </div>
            </Tooltip>
            <div class="ae-name">{a.name}</div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
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
