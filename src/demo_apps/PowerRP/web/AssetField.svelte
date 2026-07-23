<!--
  AssetField — THE asset-reference property field (manifest "ASSET property
  kind" + "ASSET UX ROUND 2": "How the hell am I supposed to insert a video
  into the video field? I click it and it's just a text box"). The asset
  sibling of ColorField/NumericField/BooleanField: it fills one row's value
  cell for every `kind: "asset"` property (image.src, video.src, filmstrip.src,
  transition.sound — core/properties.js / core/transitions.js).

  Presentation: the current asset's DISPLAY NAME (never a raw path/data-URI —
  a data: URI is shown as "(embedded image)"), a folder/browse icon button, and
  an upload icon button. Browse opens a Modal listing the CURRENT project's
  assets FILTERED to `assetKinds`, reusing the Asset Explorer's own tile
  grid/thumbnail rendering (same .ae-grid/.ae-tile/.ae-cell classes — one
  visual language for "pick an asset" everywhere, per the standardize-controls
  rule). Clicking a tile picks it; the upload button opens a native file picker
  and uploads straight into the property.

  DRAG-AND-DROP accepts BOTH surfaces (manifest: "PLUS drag-and-drop from the
  Asset Explorer (and from Finder)... I'm dragging and dropping the MOV into
  the video for the filmstrip and it doesn't even work"):
    - An Asset Explorer tile drag carries projectApi.ASSET_DRAG_MIME (JSON
      {name, kind, url}) — dropping it here PICKS that asset (no re-upload).
    - A Finder file drag carries the native "Files" type — dropping it here
      UPLOADS the file into the project then picks the freshly uploaded asset
      (the same upload path the Upload button and AssetExplorer's pane-drop
      use), so the video field itself becomes a working drop target instead of
      silently doing nothing.
  Both are gated by KIND: a dropped/picked asset whose kind isn't in
  `assetKinds` is REJECTED with a loud inline error (never silently ignored or
  silently accepted into the wrong widget).

  Write semantics: `assetForm` ("url" | "filename", from the row def) decides
  what STRING the field writes — the served path (image/video's storage) or
  the bare basename (filmstrip's storage, resolved server-side by the frames
  endpoint). One commit per pick/upload/drop (a single undo unit); no live-
  preview gesture (an asset pick is atomic, unlike a drag scrub).

  Props:
    app         — the app controller (projectName/listProjectAssets/uploadAsset).
    value       — the current stored value (a URL, bare filename, data URI, or
                  null/empty for unset).
    label       — accessible label / tooltip base.
    assetKinds  — array of accepted asset kinds (server asset_kind():
                  "image"|"video"|"sound"), from the row def.
    assetForm   — "url" (default) | "filename" — what string form to WRITE.
    nullable    — whether a "(none)" clear affordance shows (transition sound).
    disabled    — grays the control (not-yet-created item rows).
    oncommit    — (newValue) => void. The ONLY write path — called once per
                  pick/upload/drop/clear. The Inspector wires this to either
                  app.setPreview+commitPreview (item rows) or the transition
                  setTransitionProp path (plain oncommit(key, kind, value)).

  Styling lives in app.css (.assetfield; the picker modal reuses .ae-* classes
  from the Asset Explorer — app convention: no <style> block here).
-->
<script module>
  /**
   * Pure function. A human display name for a stored asset value: the
   * basename of a URL/filename, or a fixed label for a data: URI (never the
   * raw base64 blob — the manifest's "displays the asset name, not a raw path
   * textbox" requirement). Null/empty shows as null (caller renders the
   * unset placeholder).
   *
   * Examples:
   *     >>> assetDisplayName("/asset/Untitled/clip.mp4")
   *     'clip.mp4'
   *     >>> assetDisplayName("clip.mp4")
   *     'clip.mp4'
   *     >>> assetDisplayName("data:image/png;base64,iVBORw0KGgo=")
   *     '(embedded image)'
   *     >>> assetDisplayName("")
   *     null
   *     >>> assetDisplayName(null)
   *     null
   */
  export function assetDisplayName(value) {
    if (!value) return null;
    if (value.startsWith("data:")) return "(embedded image)";
    const decoded = value.includes("%") ? decodeURIComponent(value) : value;
    const parts = decoded.split("/");
    return parts[parts.length - 1] || decoded;
  }

  /**
   * Pure function. The property-write STRING for a picked library asset,
   * given the row's `assetForm`. "url" writes the asset's served path
   * (image/video storage); "filename" writes the bare basename (filmstrip
   * storage — resolved against the project's assets/ server-side).
   *
   * Examples:
   *     >>> assetWriteValue({ name: "clip.mp4", url: "/asset/P/clip.mp4" }, "url")
   *     '/asset/P/clip.mp4'
   *     >>> assetWriteValue({ name: "clip.mp4", url: "/asset/P/clip.mp4" }, "filename")
   *     'clip.mp4'
   */
  export function assetWriteValue(asset, assetForm) {
    return assetForm === "filename" ? asset.name : asset.url;
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Modal from "../../../lib/Modal.svelte";
  import AssetThumb from "./AssetThumb.svelte";
  import { ASSET_DRAG_MIME } from "./projectApi.js";

  let {
    app,
    value,
    label,
    assetKinds = ["image"],
    assetForm = "url",
    nullable = false,
    disabled = false,
    oncommit,
    // PROGRAMMATIC PICKER OPEN (manifest 14.3): when `autoOpen` flips to true the
    // field opens its picker modal by itself (a fresh filmstrip prompts for a
    // video the moment it is placed). `onpickerclose` fires when the modal
    // closes for ANY reason (pick / cancel / backdrop) so the caller can clear
    // its one-shot signal — cancel then leaves the widget exactly as it was
    // (the empty ghost). Both default to a no-op so every other consumer
    // (image/sound rows) is unaffected.
    autoOpen = false,
    onpickerclose = () => {},
  } = $props();

  let displayName = $derived(assetDisplayName(value));
  let pickerOpen = $state(false);
  let assets = $state(null); // library listing, fetched lazily on first browse
  let listError = $state(null);
  let dragging = $state(false); // valid drag hovering the field
  let dragRejected = $state(false); // a drag whose kind doesn't match, hovering
  let error = $state(null); // upload/drop failure, shown inline under the field
  let fileInput;

  /** Query. The library assets matching this field's accepted kinds. */
  let filteredAssets = $derived((assets ?? []).filter((a) => assetKinds.includes(a.kind)));

  // 14.3 AUTO-OPEN: when the caller raises `autoOpen`, open the picker once.
  // `autoOpenedFor` guards against re-opening every effect run (the signal stays
  // true until the modal closes and the caller clears it). A closed modal that
  // was auto-opened notifies the caller (onpickerclose) so it can clear its
  // one-shot signal — on pick OR cancel, so a cancel leaves the widget untouched.
  let autoOpenedFor = $state(false);
  $effect(() => {
    if (autoOpen && !autoOpenedFor && !disabled) {
      autoOpenedFor = true;
      openPicker();
    } else if (!autoOpen) {
      autoOpenedFor = false;
    }
  });
  $effect(() => {
    // Fire onpickerclose exactly when a modal we auto-opened has closed.
    if (autoOpenedFor && !pickerOpen) onpickerclose();
  });

  /** Command. Fetches the project's asset list for the picker (once per open;
   *  the Asset Explorer pane owns the authoritative live list — this is a
   *  point-in-time snapshot for picking, refreshed every time the modal
   *  opens so a just-uploaded asset shows up). Errors surface loudly in the
   *  modal instead of a silently-empty grid. */
  async function openPicker() {
    if (disabled) return;
    pickerOpen = true;
    listError = null;
    try {
      assets = await app.listProjectAssets();
    } catch (e) {
      listError = String(e?.message ?? e);
      assets = null;
      console.error("AssetField: could not list project assets:", e);
    }
  }

  function pick(a) {
    oncommit(assetWriteValue(a, assetForm));
    pickerOpen = false;
  }

  function clear() {
    oncommit(null);
  }

  function onUploadClick() {
    if (disabled) return;
    fileInput.value = "";
    fileInput.click();
  }

  /** Command. Uploads a File into the project then commits its asset value.
   *  A kind mismatch (e.g. dropping a .txt on a video field) is rejected
   *  loudly BEFORE uploading — never a silent no-op, never an upload the
   *  field then can't use. Errors surface inline (never console-only, since
   *  this is a direct user gesture on this specific field). */
  async function uploadAndCommit(file) {
    error = null;
    try {
      const res = await app.uploadAsset(file); // {ok, name, url}
      const kind = res.url ? guessKindFromName(res.name) : null;
      if (kind && !assetKinds.includes(kind)) {
        error = `"${file.name}" is a ${kind} — this field only accepts ${assetKinds.join("/")}. Uploaded to the asset library, but not applied here.`;
        console.error(`AssetField: uploaded "${file.name}" but its kind (${kind}) doesn't match this field's accepted kinds (${assetKinds.join(", ")}).`);
        return;
      }
      oncommit(assetForm === "filename" ? res.name : res.url);
    } catch (e) {
      error = String(e?.message ?? e);
      console.error("AssetField: upload failed:", e);
    }
  }

  /** Pure function. Same extension→kind classification as the server's
   * asset_kind() (server/server.py) — used only to pre-check a Finder drop's
   * kind client-side before committing (the server is still the source of
   * truth for the actual asset listing). Unknown extensions fall through as
   * "other" (rejected everywhere, same as the server).
   *
   * Examples:
   *     >>> guessKindFromName("clip.MOV")
   *     'video'
   *     >>> guessKindFromName("shot.png")
   *     'image'
   *     >>> guessKindFromName("readme.txt")
   *     'other'
   */
  function guessKindFromName(name) {
    const ext = "." + (name.split(".").pop()?.toLowerCase() ?? "");
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext)) return "image";
    if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
    if ([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) return "sound";
    if (ext === ".pdf") return "pdf";
    return "other";
  }

  function onFileChosen(e) {
    const file = e.currentTarget.files[0];
    if (file) uploadAndCommit(file);
  }

  // ── Drag-and-drop onto the field: Asset Explorer tiles OR raw Finder files ──
  function dragKind(e) {
    const types = [...e.dataTransfer.types];
    if (types.includes(ASSET_DRAG_MIME)) return "asset";
    if (types.includes("Files")) return "files";
    return null;
  }

  function onDragOver(e) {
    const kind = dragKind(e);
    if (!kind || disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dragging = true;
    // A same-page asset-tile drag exposes its payload kind only on DROP (most
    // browsers hide dataTransfer item contents during dragover for security);
    // Finder file drags never do. So the reject-highlight only applies to the
    // asset-tile case, read from the drag's custom MIME type payload when the
    // browser DOES expose it during dragover (Chrome does for same-document
    // drags) — a best-effort visual hint, never load-bearing (drop always
    // re-validates).
    if (kind === "asset") {
      try {
        const raw = e.dataTransfer.getData(ASSET_DRAG_MIME);
        if (raw) dragRejected = !assetKinds.includes(JSON.parse(raw).kind);
      } catch {
        dragRejected = false; // payload unreadable mid-drag — no hint, drop still validates
      }
    }
  }
  function onDragLeave(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    dragging = false;
    dragRejected = false;
  }
  async function onDrop(e) {
    e.preventDefault();
    dragging = false;
    dragRejected = false;
    if (disabled) return;
    error = null;
    const assetPayload = e.dataTransfer.getData(ASSET_DRAG_MIME);
    if (assetPayload) {
      // Dropped from the Asset Explorer: an existing library asset, no upload.
      const a = JSON.parse(assetPayload);
      if (!assetKinds.includes(a.kind)) {
        error = `"${a.name}" is a ${a.kind} — this field only accepts ${assetKinds.join("/")}.`;
        return;
      }
      oncommit(assetWriteValue(a, assetForm));
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length > 0) await uploadAndCommit(files[0]); // Finder drop: upload then commit
  }
</script>

<div class="assetfield" class:disabled>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="assetfield-row" ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} class:dragging class:drag-rejected={dragRejected}>
    <Tooltip text={displayName ? `${label}: ${displayName}` : `${label}: not set — drag an asset here, or use Browse/Upload`}>
      <span class="assetfield-name" class:empty={!displayName}>{displayName ?? "(none)"}</span>
    </Tooltip>
    <div class="assetfield-actions">
      {#if nullable && displayName}
        <Tooltip text="Clear">
          <button class="btn-icon" aria-label={`Clear ${label}`} {disabled} onclick={clear}>
            <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
          </button>
        </Tooltip>
      {/if}
      <Tooltip text={`Browse ${assetKinds.join("/")} assets`}>
        <button class="btn-icon" aria-label={`Browse assets for ${label}`} {disabled} onclick={openPicker}>
          <iconify-icon icon="mdi:folder-open-outline" width="14" height="14"></iconify-icon>
        </button>
      </Tooltip>
      <Tooltip text="Upload a new asset">
        <button class="btn-icon" aria-label={`Upload asset for ${label}`} {disabled} onclick={onUploadClick}>
          <iconify-icon icon="mdi:upload" width="14" height="14"></iconify-icon>
        </button>
      </Tooltip>
      <input class="assetfield-file" type="file" bind:this={fileInput} onchange={onFileChosen} />
    </div>
  </div>
  {#if error}<div class="assetfield-error">{error}</div>{/if}
</div>

<Modal bind:open={pickerOpen} title={`Choose ${assetKinds.join("/")} asset — ${label}`}>
  {#if listError}
    <div class="ae-notice ae-error">
      <div class="ae-notice-title">Couldn't load assets</div>
      <div class="ae-notice-detail">{listError}</div>
    </div>
  {:else if assets === null}
    <div class="ae-notice">Loading assets…</div>
  {:else if filteredAssets.length === 0}
    <div class="ae-notice">No {assetKinds.join("/")} assets in this project yet — Upload one.</div>
  {:else}
    <div class="ae-grid">
      {#each filteredAssets as a (a.name)}
        <div class="ae-cell">
          <Tooltip text={a.name}>
            <div class="ae-tile">
              <!-- Same generalized media + badge as the Asset Explorer (#25). -->
              <AssetThumb {app} asset={a} onclick={() => pick(a)} />
            </div>
          </Tooltip>
          <div class="ae-name">{a.name}</div>
        </div>
      {/each}
    </div>
  {/if}
</Modal>
