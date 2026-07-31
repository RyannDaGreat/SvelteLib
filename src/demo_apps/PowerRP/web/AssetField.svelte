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
  what STRING the field writes — an ASSET REF (image/video's storage) or the bare
  basename (filmstrip's storage, resolved server-side by the frames endpoint).
  Since the relative-ref grammar (core/asset_ref.js) the "url" form writes the
  RELATIVE ref for an asset of THIS project — "clip.mp4", not
  "/asset/<project>/clip.mp4" — so the document survives a rename, a Save-As and a
  zip round-trip; a FOREIGN asset still writes the absolute form, because naming
  the other project is the whole content of that reference. See assetWriteValue.
  One commit per pick/upload/drop (a single undo unit); no live-preview gesture
  (an asset pick is atomic, unlike a drag scrub).

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
   * Pure function. Is this stored value an `=` EQUATION rather than an asset
   * reference? The universal any-type gate is the leading `=` (manifest "THE `=`
   * MARKER"). An equation-valued asset row must NOT be run through
   * assetDisplayName, which would present the tail of the expression as if it
   * were a file ('="/asset/p/pic.png"' reading as the asset 'pic.png"').
   * DUPLICATED as a one-liner in ColorField (isEquationColor) for the same
   * reason: core's isEquationValue needs the owning plugin + property path,
   * which a display-level field does not have. The right home is a core
   * `isEquationString` export both would call.
   *
   * Examples:
   *     >>> isEquationAsset('="/asset/p/pic.png"')
   *     true
   *     >>> isEquationAsset("= other.src")
   *     true
   *     >>> isEquationAsset("/asset/p/pic.png")
   *     false
   *     >>> isEquationAsset(null)
   *     false
   */
  export function isEquationAsset(value) {
    return typeof value === "string" && /^\s*=/.test(value);
  }

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
   * given the row's `assetForm` and the project the document belongs to.
   *
   * "filename" writes the bare basename (filmstrip storage). "url" writes an
   * ASSET REF — and as of the relative-ref grammar (core/asset_ref.js) that ref is
   * RELATIVE whenever the asset belongs to `project`, i.e. it is the same bare path
   * "filename" would have written. The two forms converge for an own-project asset
   * and stay distinct for a FOREIGN one, where "url" keeps the absolute
   * "/asset/<other>/<file>" that says which project it came from.
   *
   * WHY WRITERS GO RELATIVE. An absolute ref bakes a project name that nothing keeps
   * true — Save-As and zip-import both mint the divergence — and the failure it
   * causes is invisible until the deck leaves the machine. The user hit it live: a
   * RobotSim zip dragged onto the static site imported its assets and still showed no
   * video, because the doc said "/asset/Untitled/Video_….mp4" and no "Untitled"
   * existed there. A relative ref has no name to be wrong about. Existing documents
   * are NOT migrated (both forms resolve forever); only new writes changed.
   *
   * `project` is passed rather than read from a global so this stays pure and
   * testable in bare node.
   *
   * Examples:
   *     >>> assetWriteValue({ name: "clip.mp4", url: "/asset/P/clip.mp4" }, "url", "P")
   *     'clip.mp4'                       // own-project: RELATIVE, rename-proof
   *     >>> assetWriteValue({ name: "clip.mp4", url: "/asset/Other/clip.mp4" }, "url", "P")
   *     '/asset/Other/clip.mp4'          // foreign: absolute, deliberately
   *     >>> assetWriteValue({ name: "clip.mp4", url: "/asset/P/clip.mp4" }, "filename", "P")
   *     'clip.mp4'
   *     >>> assetWriteValue({ name: "x.svg", url: "builtin:library/x.svg" }, "url", "P")
   *     'builtin:library/x.svg'          // not an asset ref: untouched
   */
  export function assetWriteValue(asset, assetForm, project) {
    if (assetForm === "filename") return asset.name;
    return relativeAssetRef(asset.url, project);
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import Modal from "../../../lib/Modal.svelte";
  import AssetThumb from "./AssetThumb.svelte";
  import { ASSET_DRAG_MIME } from "./projectApi.js";
  import { relativeAssetRef } from "../core/asset_ref.js";

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

  // An `=` equation is not an asset reference: it renders AS an expression, and
  // every write affordance (Browse / Upload / Clear / drop) stands down, because
  // each would replace the expression with a literal. Editing it belongs to the
  // Inspector row's universal `=` field (Tier 0), which owns the equation UX for
  // every kind. Reachable today through the Inspector's grayed not-yet-created
  // rows, which display RAW creation-slide state.
  let equation = $derived(isEquationAsset(value));
  let displayName = $derived(assetDisplayName(value));
  let pickerOpen = $state(false);
  let assets = $state(null); // library listing, fetched lazily on first browse
  let listError = $state(null);
  let dragging = $state(false); // valid drag hovering the field
  let dragRejected = $state(false); // a drag whose kind doesn't match, hovering
  let error = $state(null); // upload/drop failure, shown inline under the field
  // $state because the hidden file input now lives inside a conditional block
  // (an equation-bound row renders no upload affordance), so bind:this assigns
  // and clears it as that block mounts and unmounts.
  let fileInput = $state(null);

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
    oncommit(assetWriteValue(a, assetForm, app.projectName()));
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
      // An UPLOAD lands in THIS project by construction, so the ref it writes is
      // relative for the same reason a picked own-project asset's is (see
      // assetWriteValue): the doc must survive a rename and a zip round-trip.
      oncommit(assetWriteValue({ name: res.name, url: res.url }, assetForm, app.projectName()));
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
   *     >>> guessKindFromName("sales.CSV")
   *     'data'
   *     >>> guessKindFromName("readme.txt")
   *     'other'
   */
  function guessKindFromName(name) {
    const ext = "." + (name.split(".").pop()?.toLowerCase() ?? "");
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext)) return "image";
    if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
    if ([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) return "sound";
    if (ext === ".pdf") return "pdf";
    // TABULAR DATA (server.py DATA_EXTS) — what a chart widget's picker offers.
    if ([".csv", ".tsv", ".json"].includes(ext)) return "data";
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
    // An equation-bound row shows the reject highlight up front; the drop itself
    // still fires and says WHY (onDrop) rather than quietly doing nothing.
    if (equation) {
      dragRejected = true;
      return;
    }
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
    if (equation) {
      error = `${label} is bound to an equation — clear it in the row's ƒ equation field before dropping an asset here.`;
      return;
    }
    const assetPayload = e.dataTransfer.getData(ASSET_DRAG_MIME);
    if (assetPayload) {
      // Dropped from the Asset Explorer: an existing library asset, no upload.
      const a = JSON.parse(assetPayload);
      if (!assetKinds.includes(a.kind)) {
        error = `"${a.name}" is a ${a.kind} — this field only accepts ${assetKinds.join("/")}.`;
        return;
      }
      oncommit(assetWriteValue(a, assetForm, app.projectName()));
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length > 0) await uploadAndCommit(files[0]); // Finder drop: upload then commit
  }
</script>

<div class="assetfield" class:disabled>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="assetfield-row" ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} class:dragging class:drag-rejected={dragRejected}>
    {#if equation}
      <!-- EQUATION-BOUND: the ƒ mark + the expression itself, in place of a name
           that would be a slice of the expression. No Browse / Upload / Clear —
           each writes a literal over the equation. -->
      <Tooltip text={`${label} is an equation — edit it in the row's ƒ field`}>
        <span class="assetfield-name">
          <iconify-icon icon="mdi:function-variant" width="13" height="13"></iconify-icon>
          {value}
        </span>
      </Tooltip>
    {:else}
    <Tooltip text={displayName ? `${label}: ${displayName}` : `${label}: not set — drag an asset here, or Browse/Upload`}>
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
    {/if}
  </div>
  {#if error}<div class="assetfield-error">{error}</div>{/if}
</div>

<!-- size="large" is REQUIRED: the tile grid is auto-fill/minmax, which collapses
     to a few columns under the content-sized Modal default. -->
<Modal bind:open={pickerOpen} title={`Choose ${assetKinds.join("/")} asset — ${label}`} size="large">
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
          <!-- The tip says what the CLICK does and wraps the ellipsized label, so
               this tile is no weaker than its identical twin in the Asset Explorer.
               It was `text={a.name}` — a label echo of the .ae-name directly below
               it (banned), which also never mentioned that clicking picks. -->
          <Tooltip text={`${a.name} (${a.kind}) — click to use it for ${label}`}>
            <div class="ae-tile">
              <!-- Same generalized media + badge as the Asset Explorer (#25). -->
              <AssetThumb {app} asset={a} onclick={() => pick(a)} />
            </div>
            <div class="ae-name">{a.name}</div>
          </Tooltip>
        </div>
      {/each}
    </div>
  {/if}
</Modal>
