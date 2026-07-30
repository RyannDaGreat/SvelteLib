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
  import { relativeMtime } from "./projectPreviews.js";
  import { rpFuzzyScore } from "../core/fuzzy.js";

  /**
   * Pure function. The assets matching a fuzzy query, best match FIRST — the same
   * ranking the COMMAND PALETTE uses, because it is the same function
   * (core/fuzzy.js rpFuzzyScore, rp's completion ranker). Reused rather than
   * reimplemented on purpose: a second scorer would mean typing "vid" ranks
   * differently in two places in one app, and the user learns one of them wrong.
   *
   * The query is matched against the asset's PATH — the served
   * "/asset/<Project>/<file>" string, not just the basename — per the user ruling
   * ("just fuzzy search by path. That's all."). That matters even in a flat
   * library: the path is what a widget's `src` holds and what the copy-path button
   * copies, so searching for the string you pasted somewhere finds it.
   *
   * An EMPTY query returns the list UNCHANGED — same array order, so opening the
   * search box does not reshuffle the grid before a single character is typed.
   * A query matching nothing returns [] (the caller shows a no-matches notice, not
   * a silently empty pane).
   *
   * @param {Array<{name: string, url: string}>} assets - a listAssets listing
   * @param {string} query - the raw filter text
   * @returns {Array<object>} matching assets, best-scoring first
   *
   * @example
   * // Fuzzy, not substring: "cmp4" finds "clip.mp4" through the gaps.
   * // filterAssets([{name: "clip.mp4", url: "/asset/D/clip.mp4"}, {name: "logo.png", url: "/asset/D/logo.png"}], "cmp4")
   * //   => [{name: "clip.mp4", …}]
   * @example
   * // An empty query is not a filter — the listing passes through untouched.
   * // filterAssets([{name: "b.png", url: "/asset/D/b.png"}, {name: "a.png", url: "/asset/D/a.png"}], "  ")
   * //   => the same two, still b then a
   * @example
   * // filterAssets([{name: "logo.png", url: "/asset/D/logo.png"}], "zzz") // => []
   */
  export function filterAssets(assets, query) {
    const list = assets ?? [];
    const q = String(query ?? "").trim();
    if (q === "") return list;
    return list
      .map((a) => ({ a, score: rpFuzzyScore(q, a.url ?? a.name) }))
      .filter((r) => r.score !== null)
      .sort((x, y) => x.score - y.score) // LOWER is better (core/fuzzy.js's convention)
      .map((r) => r.a);
  }

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
   * Pure function. An asset tile's hover tip as THREE STRUCTURED PARTS, not one
   * sentence — the shape the user ruled for every tile tip in this app:
   *
   *     line 1  the FILE NAME, on its own and BOLD
   *     line 2  kind · size, ITALIC (size through web/fileSize.js)
   *     line 3+ the description: the age, and what the tile's gestures do
   *
   * Verbatim ruling: "the file name should always be the top and then everything
   * else comes in a new line after that… Number.plugin.js in the hover tooltip
   * should always be bold. The file name should always be bold in that tooltip."
   *
   * WHY PARTS AND NOT A STRING. The old version returned one em-dash-joined
   * sentence, which cannot be styled: there is no way for a renderer to bold just
   * the name inside "clip.mp4 — video · 25.8MB — drag onto…". Returning the parts
   * lets the Tooltip's `tip` SNIPPET mark each one up (see the grid below) while
   * keeping every decision about WHAT the tip says pure and testable here. It is
   * also why `name` is a field rather than being pre-concatenated: the caller bolds
   * it, so it must arrive unglued from anything else.
   *
   * A missing size or mtime DROPS its clause rather than printing a placeholder —
   * the projectMetaLine convention (web/projectPreviews.js). `meta` is therefore
   * "kind" alone for a listing with no metadata, never "kind · undefined".
   *
   * THE DOUBLE-CLICK CLAUSE IS PER KIND, because the gesture does three different
   * things (onTileDoubleClick): a PLUGIN asset opens the JavaScript editor, a DATA
   * asset opens a table, everything else plays/shows its media. One flat
   * "double-click to preview" was true of all assets until those two kinds existed
   * and is now a lie about both — and the code editor in particular is the kind of
   * outcome a user should not discover by accident.
   *
   * @param {{name:string, kind:string, size?:number, mtime?:number, builtin?:boolean}} a - one listAssets entry
   * @param {number} nowMs - current time in MILLISECONDS, for the relative age
   * @returns {{name: string, meta: string, description: string}}
   *
   * @example
   * // A 25.8MB video modified two hours ago — name alone, then kind · size, then prose:
   * // assetTipParts({name:"clip.mp4", kind:"video", size:27100000, mtime:0}, 2*3600*1000)
   * // => {name: "clip.mp4",
   * //     meta: "video · 25.8MB",
   * //     description: "Modified 2 hours ago. Drag onto the canvas to insert at a point, or double-click to preview."}
   * @example
   * // A listing with no size/mtime drops both clauses and still names the gestures:
   * // assetTipParts({name:"x.png", kind:"image"}, 0)
   * // => {name: "x.png", meta: "image",
   * //     description: "Drag onto the canvas to insert at a point, or double-click to preview."}
   * @example
   * // A PLUGIN asset's double-click EDITS ITS SOURCE, and the tip says so:
   * // assetTipParts({name:"Number.plugin.js", kind:"plugin", size:2048}, 0).description
   * // => "Drag onto the canvas to insert at a point, or double-click to edit its JavaScript."
   * @example
   * // A BUILT-IN says so first: it is not in the project and cannot be deleted,
   * // and its editor opens read-only (a copy is what Save writes).
   * // assetTipParts({name:"clock_digital.plugin.js", kind:"plugin", size:900, builtin:true}, 0).description
   * // => "Built-in — ships with the app, not stored in this project. Drag onto the canvas to insert at a point, or double-click to edit its JavaScript."
   */
  export function assetTipParts(a, nowMs) {
    const facts = [a.kind];
    if (a.size != null) facts.push(humanReadableFileSize(a.size));
    const sentences = [];
    if (a.builtin) sentences.push("Built-in — ships with the app, not stored in this project.");
    // The AGE moves into the description rather than sitting in the meta line: the
    // ruling fixes line 2 as "kind · size", and an age is prose about the file's
    // history rather than an identity fact of the same kind as its type and weight.
    if (a.mtime != null) sentences.push(`Modified ${relativeMtime(a.mtime, nowMs)}.`);
    sentences.push(`Drag onto the canvas to insert at a point, or ${doubleClickClause(a.kind)}.`);
    return { name: a.name, meta: facts.join(" · "), description: sentences.join(" ") };
  }

  /**
   * Pure function. What a double-click on a tile of `kind` DOES, as the tail of
   * assetTip's sentence. Its own function so the three outcomes are one greppable
   * table rather than a conditional buried in a template string.
   *
   * @param {string} kind - an asset kind (server.py asset_kind / assetKindForName)
   * @returns {string}
   *
   * @example doubleClickClause("plugin") // "double-click to edit its JavaScript"
   * @example doubleClickClause("data")   // "double-click to view the table"
   * @example doubleClickClause("video")  // "double-click to preview"
   * @example doubleClickClause("other")  // "double-click to preview"
   */
  export function doubleClickClause(kind) {
    if (kind === "plugin") return "double-click to edit its JavaScript";
    if (kind === "data") return "double-click to view the table";
    return "double-click to preview";
  }

  /**
   * Pure function. The trash can's hover sentence, which must distinguish the
   * button's TWO OUTCOMES — because it has two and they are not equally
   * recoverable. onTrashClick deletes IMMEDIATELY when nothing references the
   * asset (a server-side delete: no confirmation, no undo) and asks first when
   * something does. One flat "Delete asset from the project" left the user unable
   * to tell which of those a click was about to do, and the unguarded branch is
   * the destructive one.
   *
   * @param {string} name - the asset's filename
   * @param {number} users - how many widgets reference it
   * @returns {string}
   *
   * @example
   * // Nothing uses it: the click is immediate and final, and says so.
   * // deleteTip("clip.mp4", 0)
   * // => 'Delete "clip.mp4" — nothing in this deck uses it, so it goes immediately. This cannot be undone.'
   * @example
   * // Something uses it: a confirmation is coming, so the click is safe to try.
   * // deleteTip("logo.png", 3)
   * // => 'Delete "logo.png" — 3 widgets use it, so you will be asked to confirm first.'
   * @example
   * // deleteTip("logo.png", 1) // => '… — 1 widget uses it, so you will be asked to confirm first.'
   */
  export function deleteTip(name, users) {
    if (users === 0)
      return `Delete "${name}" — nothing in this deck uses it, so it goes immediately. This cannot be undone.`;
    return `Delete "${name}" — ${users} ${users === 1 ? "widget uses" : "widgets use"} it, so you will be asked to confirm first.`;
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
  import CsvTable from "./CsvTable.svelte"; // the DATA asset's branch of the preview Modal
  import { KIND_ICON } from "./assetThumbnail.js";
  import { ASSET_DRAG_MIME, isProjectZip } from "./projectApi.js";
  import { quotaLine, quotaPercent } from "./assetStore.js";
  import { libraryTotalsLine } from "./assetRef.js";
  import { builtinWidgetAssets } from "./builtinAssets.js";
  import { assetStore } from "./storageMode.js"; // resolves an asset ref for THIS page's storage
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
  let listedNowMs = $state(Date.now()); // captured per listing, for the tiles' relative-age tip

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

  // ── BUILT-IN ASSETS (user ruling: "maybe the asset explorer could have a toggle
  // for built-in assets. By default it's turned off") ──────────────────────────
  //
  // `listedAssets` is THE list every consumer below reads — the grid, the empty
  // state, and the totals line — so the toggle cannot be honoured by one and missed
  // by another. That single-source shape is the point: an earlier version of this
  // pane derived the count separately from the grid, which is exactly how a totals
  // line ends up disagreeing with the tiles above it.
  //
  // Built-ins go AFTER the project's own assets, never interleaved: the pane answers
  // "what is in MY project" first, and a shipped widget appearing between two of the
  // user's uploads would make the library feel like project content the user could
  // delete (it cannot be — see the tile's guard in onTrashClick).
  //
  // The toggle is a VIEW filter and nothing more. Every built-in widget is registered
  // at boot in every mode regardless, so a deck using one renders identically with
  // the toggle off — hiding them hides ROWS, never capability.
  let builtinAssets = $derived(app.showBuiltinAssets ? builtinWidgetAssets() : []);
  let listedAssets = $derived(assets === null ? null : [...assets, ...builtinAssets]);

  // The LIBRARY TOTALS line — "12 assets · 187MB". Formatted through
  // web/fileSize.js (via libraryTotalsLine's injected formatter), never raw bytes.
  // It totals `listedAssets`, i.e. exactly what is on screen, which is what makes
  // built-ins excluded while the toggle is off and included while it is on.
  let totalsText = $derived(libraryTotalsLine(listedAssets, humanReadableFileSize));

  // ── STORAGE BUDGET (user ruling: "if there is a certain amount of storage per
  // user, per browser, it should say that amount of storage so they know how
  // close they are to filling it up") ────────────────────────────────────────
  // The reading from navigator.storage.estimate(), refreshed alongside the asset
  // list (so an upload's effect on the number is visible immediately). In HTTP
  // mode quota() reports {supported:false} with no error and quotaLine() returns
  // null, so NOTHING renders — a server has no per-browser budget to be near.
  // Percent-full at which the line switches to the theme's danger color. The
  // numeric twin of app.css's --a-quota-full-at (CSS cannot compare a custom
  // property to a threshold, so the COMPARISON is here and the COLOR is there).
  const QUOTA_FULL_AT_PCT = 90;
  let quota = $state(null);
  let quotaText = $derived(quotaLine(quota, humanReadableFileSize));
  let quotaPct = $derived(quotaPercent(quota));
  let quotaNearlyFull = $derived(quotaPct !== null && quotaPct >= QUOTA_FULL_AT_PCT);

  /** Command. Re-read the storage budget. Called from refresh(), so the line
   *  tracks every upload/delete. A quota() reading NEVER throws (it reports
   *  {supported:false, error} instead — see localDb.storageBudget): this readout
   *  must not be able to break the pane that hosts the asset grid. */
  async function refreshQuota() {
    quota = await app.storageQuota();
  }

  /** Query. The quota tooltip's detail sentence: the exact percent, whether the
   *  browser has granted PERSISTENT storage, and what to do about it. The line
   *  itself is deliberately short ("4.6MB of 2.0GB used"); the reason a user
   *  cares — that non-persistent storage can be EVICTED — belongs in the detail
   *  rather than the pane's one visible row. */
  function quotaDetail() {
    const parts = [`Browser storage for this site: ${quotaText}.`];
    if (quotaPct !== null) parts.push(`That is ${quotaPct}% of the browser's budget for this origin.`);
    parts.push(
      quota?.persisted
        ? "Storage is PERSISTENT — the browser will not evict your projects under storage pressure."
        : "Storage is BEST-EFFORT: the browser may evict it under storage pressure. Export a .zip for a durable copy.",
    );
    parts.push("The figure is an estimate covering everything this site stores, and browsers round it deliberately.");
    return parts.join(" ");
  }

  /** Query. The built-in toggle's hover sentence. It states the CURRENT state and
   *  what clicking does, because the button's only visual cue is a tint — and it
   *  names the one thing a user could otherwise get wrong: hiding built-ins is a
   *  list filter, not an uninstall, so a deck using one keeps working. */
  function builtinToggleTip() {
    return app.showBuiltinAssets
      ? `Built-in assets are SHOWN (${builtinAssets.length} in the widget library). Click to hide them and list only this project's own assets. Hiding is a view filter — built-in widgets stay available either way.`
      : "Built-in assets are HIDDEN. Click to also list the widget library that ships with the app — tier-1 vector widgets you can drag onto the canvas.";
  }

  /** Query. The totals line's detail sentence: what the count covers, and — when
   *  built-ins are being counted — that part of it is bundled with the app rather
   *  than stored in the project, since otherwise the figure looks like it contradicts
   *  the storage line right above it. */
  function totalsDetail() {
    const parts = [`This library lists ${totalsText}.`];
    if (builtinAssets.length)
      parts.push(`${builtinAssets.length} of those are BUILT-IN widgets that ship inside the app — they travel with every project and cost you no storage.`);
    parts.push("Sizes are the assets' own bytes; a built-in widget's size is the length of its source.");
    return parts.join(" ");
  }

  // HOW MANY WIDGETS USE EACH ASSET — asset name → user count, recomputed ONCE
  // PER COMMIT and read per tile.
  //
  // WHY A DERIVED AND NOT A CALL IN THE TOOLTIP EXPRESSION: assetUsers walks
  // every slide × every item in that slide's delta, so calling it per tile per
  // render would make the pane's cost (tiles × slides × items) and put it on the
  // hover path. Hovering must be FREE (the manifest's hover invariant, and the
  // defect behind the minimap drag spike). app.doc's identity flips on every
  // commit and only then, so this is one pass per document change — the same
  // per-commit-not-per-move discipline CommandPalette uses for `when`.
  let assetUserCounts = $derived.by(() => {
    const doc = app.doc;
    const counts = new Map();
    for (const a of assets ?? []) counts.set(a.name, assetUsers(doc, a.name, a.url).length);
    return counts;
  });

  /** Query. A LOADABLE URL for an asset, through THE STORAGE SEAM: the backend
   *  base in server mode, a blob: object URL in browser-local mode. Resolving it
   *  as a server path unconditionally is how the preview modal 404'd in static
   *  mode against a file the browser was in fact holding. */
  function urlOf(a) {
    return assetStore().resolveUrl(a.url);
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
      // Captured once per LISTING, not read live per tooltip — the Open Project
      // modal's openNowMs precedent (web/App.svelte). A relative age that
      // recomputed on every render would make every tile tooltip a fresh string.
      listedNowMs = Date.now();
      assets = await app.listProjectAssets();
      // A finished ("done") optimistic tile is dropped here — once, and only
      // once its REAL tile is present in this fresh listing — so the swap has
      // no flicker gap (see app.reconcileUploads).
      app.reconcileUploads(assets);
      // Register any FONT assets as selectable families (#26) — a manual folder
      // drop or a returning project must offer its uploaded fonts in the dropdown.
      app.registerFontAssets(assets);
      // The storage line tracks the library, so it is re-read with it. Awaited
      // INSIDE the try only for ordering; it cannot throw (see refreshQuota).
      await refreshQuota();
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
  /** Command. Pane drop. A .zip is a whole PROJECT, not an asset (the one rule
   *  lives in projectApi.isProjectZip), so it IMPORTS + opens exactly as it does
   *  on the canvas rather than landing in this library as an opaque archive —
   *  the two drop surfaces must not disagree about what a .zip means. Everything
   *  else uploads as before. Errors surface in the pane's own error line. */
  async function onDrop(e) {
    e.preventDefault();
    dragging = false;
    const files = [...e.dataTransfer.files];
    const zip = files.find(isProjectZip);
    if (!zip) return uploadFiles(files);
    error = null;
    try {
      await app.importProjectZip(zip); // reports its own result/refusal in the UI too
    } catch (err) {
      error = String(err?.message ?? err);
      console.error("AssetExplorer: .zip import failed:", err);
    }
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

  // ── DOWNLOAD ONE ASSET (user ruling: "In addition to the trash icon and copy
  // path icon, there should also always be a download icon") ──────────────────
  //
  // THROUGH THE ASSET STORE, not a link straight at `a.url`. An <a href="/asset/…"
  // download> works only in HTTP mode; in browser-local (IndexedDB) mode there is no
  // origin serving that path, so the same markup would download the app's 404 page
  // under the asset's name — a silent wrong answer of exactly the kind this pane
  // refuses. store.get() returns the bytes in BOTH modes, so one code path serves
  // both, and it also covers the built-in library (whose `url` is a
  // `builtin:` IDENTIFIER that is not fetchable at all — see downloadAsset's
  // built-in branch).
  //
  // The object URL is revoked after the click: unlike the store's own memoized
  // preview URLs (which must outlive a mounted <img>), this one exists for exactly
  // one navigation and leaking one per download would be a real leak.

  /** Command (downloads a file; mutates nothing in the app). Save ONE asset to the
   *  user's disk. Reads the bytes through the storage seam — or, for a BUILT-IN,
   *  straight from the bundled source string, which is the only place those bytes
   *  exist — mints a temporary object URL, clicks a synthetic <a download>, and
   *  revokes it. Failures surface in the pane's own error line AND the console; a
   *  download that did not happen must never look like one that did. */
  async function downloadAsset(a) {
    error = null;
    try {
      // A built-in is not in any store: its bytes ARE the bundled source (see
      // builtinAssets.builtinWidgetAssets). Wrapping it in a Blob here means the
      // download path below is identical for both origins.
      const blob = a.builtin
        ? new Blob([a.source], { type: "text/javascript" })
        : await assetStore().get(app.projectName(), a.name);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = a.name; // the asset's own basename, never the resolved URL's
      // Must be IN the document for the synthetic click to navigate in Firefox;
      // removed immediately after, so no stray node outlives the download.
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      error = String(e?.message ?? e);
      console.error(`AssetExplorer: could not download "${a.name}":`, e);
    }
  }

  /** Query. The download button's hover sentence. It names the FILE and the SIZE
   *  being written, because that is the one thing a user wants confirmed before a
   *  25MB video lands in their Downloads folder — and for a built-in it says the
   *  bytes come from the app rather than from the project. */
  function downloadTip(a) {
    const size = a.size != null ? ` (${humanReadableFileSize(a.size)})` : "";
    if (a.builtin) return `Download “${a.name}”${size} — the built-in widget's source, as shipped with the app.`;
    return `Download “${a.name}”${size} to your computer.`;
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

  // ── FUZZY PATH SEARCH (user ruling: "a search button in there, which when
  // clicked will toggle a filter area that lets me fuzzy search… just fuzzy search
  // by path. That's all.") ────────────────────────────────────────────────────
  // NOT PERSISTED, deliberately. A filter is a MOMENT, not a preference: coming
  // back to a project tomorrow and finding two of its twelve assets — because of a
  // query typed once — would look like data loss, and this pane's whole job is to
  // tell the truth about what the project contains. So the state is component-local
  // and dies with the pane, unlike the built-ins toggle beside it (which IS a
  // preference and IS persisted).
  //
  // Filtering is core/fuzzy.js's rpFuzzyScore through filterAssets above — the SAME
  // ranking the command palette uses.
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchInput; // the <input>, focused on open (a toggled search box that needs a click is a two-gesture search)

  /** The listing the grid actually renders: `listedAssets` (project assets plus,
   *  when its toggle is on, the built-in library) when the box is closed or empty,
   *  else the fuzzy matches of that, best-first.
   *
   *  COMPOSED ON listedAssets, NOT ON `assets`: the two view filters in this
   *  header — built-ins and search — must STACK, or turning both on would show a
   *  filtered project list beside an unfiltered built-in library, and the totals
   *  line would agree with neither. One chain, one truth.
   *
   *  Derived, so typing re-ranks without a re-list (no network call per keystroke). */
  let shownAssets = $derived(
    searchOpen ? filterAssets(listedAssets, searchQuery) : (listedAssets ?? []),
  );
  /** True when a query is active and matched NOTHING — the pane says so rather than
   *  showing an empty grid, which is indistinguishable from an empty project. */
  let noMatches = $derived(searchOpen && searchQuery.trim() !== "" && shownAssets.length === 0);

  /** Command. Toggles the filter area. Opening focuses the input; CLOSING clears
   *  the query, because a hidden filter still filtering is the worst of the three
   *  states this button can be in — the grid would be short for a reason with no
   *  visible cause. */
  function toggleSearch() {
    searchOpen = !searchOpen;
    if (!searchOpen) return (searchQuery = "");
    // The input does not exist until this render commits; focus after it does.
    requestAnimationFrame(() => searchInput?.focus());
  }

  /** Command. Escape inside the box CLEARS AND CLOSES (the user ruling), and the
   *  key is CONSUMED so it does not also reach the app's global Escape (which
   *  clears the canvas selection — dismissing a filter must not deselect a widget).
   *
   *  ONLY Escape. ENTER IS DELIBERATELY NOT HANDLED: the grid filters live on every
   *  keystroke, so there is nothing for Enter to commit, and consuming it would
   *  oblige this box to advertise an Enter chip for a key that does nothing — the
   *  lie core/shortcut_entries.js's item-61 doctrine forbids (tests/shortcut_sweep_test.js
   *  is what caught the first draft doing exactly that). Unhandled, Enter is the
   *  browser's own inert no-op inside a lone text input, which is correct. */
  function onSearchKeydown(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    toggleSearch();
  }

  // ── DATA (CSV/TSV) PREVIEW: read the text for the preview Modal's table ──────
  // Through the asset STORE seam (store.get → Blob → .text()), NOT fetch(): that is
  // what makes the table work identically against the Python backend and against
  // IndexedDB in static mode, where there is no origin to fetch from. Same seam
  // pluginAssetLoader.js reads plugin sources through, for the same reason.
  let previewText = $state(null);  // the loaded text, or null while loading/none
  let previewTextError = $state(null);

  /** Command. Loads a data asset's text for the preview table. A failure is shown
   *  IN THE DIALOG (previewTextError) rather than leaving an empty table that a
   *  reader would take for an empty file. */
  async function loadPreviewText(a) {
    previewText = null;
    previewTextError = null;
    try {
      const blob = await assetStore().get(app.projectName(), a.name);
      previewText = await blob.text();
    } catch (e) {
      previewTextError = String(e?.message ?? e);
      console.error(`AssetExplorer: could not read "${a.name}" for the table preview:`, e);
    }
  }

  // ── DOUBLE-CLICK A PLUGIN ASSET → EDIT ITS JAVASCRIPT (user ruling: "If I
  // double click a plugin, it should let me edit the JavaScript inside of it") ──
  // A *.plugin.js tile's double-click opens the Monaco modal instead of the media
  // preview, because there is no media to preview — the file IS source. The app
  // owns the whole lifecycle (app.svelte.js's "asset" code-modal scope: read the
  // bytes, validate on save, write back through the store, re-register the widget);
  // this pane only routes the gesture and surfaces a read failure in its own error
  // line, where every other asset failure in this pane already appears.

  /** Command. The tile's double-click: a plugin asset opens the CODE editor, a
   *  data asset opens the TABLE, everything else opens the media preview. ONE
   *  gesture, dispatched on kind — the alternative (a second affordance per kind)
   *  is how a tile ends up with four buttons the user must choose between. */
  async function onTileDoubleClick(a) {
    if (a.kind === "plugin") {
      error = null;
      try {
        await app.openPluginAssetCode(a.name);
      } catch (e) {
        error = String(e?.message ?? e);
        console.error(`AssetExplorer: could not open "${a.name}" for editing:`, e);
      }
      return;
    }
    openPreview(a);
    if (a.kind === "data") await loadPreviewText(a);
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
    <!-- SHOW BUILT-IN ASSETS — default OFF, persisted per browser (user ruling).
         A pressed-state toggle button, not a checkbox, to match the other icon
         toggles in this app's chrome; aria-pressed carries the state for a screen
         reader since the only visual cue is the button's active tint. Immediate
         Tooltip, per the house rule against native title=. -->
    <Tooltip text={builtinToggleTip()}>
      <button
        class="btn-icon"
        class:active={app.showBuiltinAssets}
        aria-label="Show built-in assets"
        aria-pressed={app.showBuiltinAssets}
        onclick={() => app.toggleShowBuiltinAssets()}
      >
        <iconify-icon icon="mdi:shape-plus-outline" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <!-- SEARCH — toggles the filter area below this row (user ruling). Same
         pressed-state icon-button chrome as the built-ins toggle beside it, so the
         two toggles in this one header row read as one family; aria-pressed carries
         the state, and the aria-expanded/aria-controls pair says WHAT it toggles
         (the filter area is a sibling, not a child, so a reader needs the link). -->
    <Tooltip text="Search this project's assets by path (fuzzy — the command palette's matcher). Escape clears and closes.">
      <button
        class="btn-icon"
        class:active={searchOpen}
        aria-label="Search assets"
        aria-pressed={searchOpen}
        aria-expanded={searchOpen}
        aria-controls="ae-search-area"
        onclick={toggleSearch}
      >
        <iconify-icon icon="mdi:magnify" width="16" height="16"></iconify-icon>
      </button>
    </Tooltip>
    <!-- Hidden file input drives the Upload button. -->
    <input class="ae-file" type="file" multiple bind:this={fileInput} onchange={onFileChosen} />
  </div>

  <!-- THE FILTER AREA — present only while the search toggle is on, so the pane
       costs no vertical space in the (overwhelmingly common) unfiltered case. One
       input and a clear (×); no options, no scope selector, no kind facets: the
       ruling was "just fuzzy search by path. That's all." -->
  {#if searchOpen}
    <div class="ae-search" id="ae-search-area">
      <iconify-icon class="ae-search-glyph" icon="mdi:magnify" width="14" height="14" aria-hidden="true"></iconify-icon>
      <input
        class="ae-search-input"
        type="text"
        placeholder="Fuzzy filter by path…"
        aria-label="Filter assets by path"
        data-hint-scope="filter"
        bind:this={searchInput}
        bind:value={searchQuery}
        onkeydown={onSearchKeydown}
      />
      {#if searchQuery}
        <Tooltip text="Clear the filter (Escape also closes the search box)">
          <button class="btn-icon ae-search-clear" aria-label="Clear asset filter" onclick={() => (searchQuery = "")}>
            <iconify-icon icon="mdi:close" width="14" height="14"></iconify-icon>
          </button>
        </Tooltip>
      {/if}
    </div>
  {/if}

  <!-- STORAGE BUDGET LINE — always visible in browser-local (static) mode, and
       ABSENT in server mode, where there is no per-browser quota to be near
       (quotaText is null then, so this whole block does not render). The visible
       row is deliberately one short sentence plus a fill bar; the tooltip carries
       the detail (exact percent, persistent-vs-evictable, and the estimate
       caveat). Immediate Tooltip: a storage warning must answer on hover, not
       after a delay. -->
  {#if quotaText}
    <Tooltip text={quotaDetail()}>
      <!-- TEXT ONLY (user ruling: "I don't need the bar… just the text is good
           enough"): the percent still lives in the hover detail and the
           nearly-full tint still warns — the fill graph is gone. -->
      <div class="ae-quota" class:ae-quota-nearly-full={quotaNearlyFull} aria-label={`Storage: ${quotaText}`}>
        <div class="ae-quota-text">{quotaText}</div>
      </div>
    </Tooltip>
  {/if}

  <!-- LIBRARY TOTALS LINE — "12 assets · 187MB". Renders in BOTH storage modes,
       unlike the quota line above it: this counts what is IN THE PROJECT, which is
       equally knowable from a server listing and from IndexedDB, whereas a
       per-origin browser budget only exists in local mode. Sizes are formatted
       through web/fileSize.js (rp-faithful), never printed as raw bytes. -->
  {#if totalsText}
    <Tooltip text={totalsDetail()}>
      <div class="ae-totals" aria-label={`Library: ${totalsText}`}>{totalsText}</div>
    </Tooltip>
  {/if}

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
    {:else if noMatches}
      <!-- A FILTER THAT MATCHED NOTHING says so, and says what it filtered — an
           empty grid is indistinguishable from an empty project, and the user would
           reasonably conclude their assets were gone. -->
      <div class="ae-notice">
        No asset path matches “{searchQuery}”.
      </div>
    {:else if listedAssets.length === 0}
      <div class="ae-notice">
        No assets yet — Upload, or drop a file onto this pane.
      </div>
    {:else}
      <!-- An EMPTY project with built-ins SHOWN still renders the grid: the
           condition above is on listedAssets, not on `assets`, so turning the
           toggle on in a fresh project shows the library instead of the
           "No assets yet" notice contradicted by tiles beneath it. -->
      {@render assetGrid()}
    {/if}
  </div>

  {#snippet assetGrid()}
      <div class="ae-grid">
        <!-- shownAssets = listedAssets through the fuzzy filter (both view filters
             STACK — see its derivation), and KEYED ON `url`, NOT `name`. Both matter
             now that built-ins can share the grid: `url` is unique by construction
             (a project ref is "/asset/<project>/<file>", a built-in is
             "builtin:library/<file>" — see builtinAssets.BUILTIN_URL_PREFIX),
             whereas a project asset named donut.plugin.js would collide with the
             built-in of that name and Svelte would refuse the duplicate key. -->
        {#each shownAssets as a (a.url)}
          <div class="ae-cell">
            <!-- THE TILE TIP, in the user's ruled STRUCTURE (assetTipParts):
                   line 1  the FILE NAME, alone and BOLD
                   line 2  kind · size, ITALIC (size via web/fileSize.js)
                   line 3  the description — age, and what the gestures do
                 A `tip` SNIPPET rather than `text=`, because the ruling is about
                 MARKUP ("the file name should always be bold in that tooltip") and a
                 flat string cannot bold one of its own clauses. The decisions about
                 WHAT it says stay in the pure assetTipParts above; this only marks up
                 the parts it returns.

                 The description names BOTH of the tile's gestures. Double-click is
                 deliberately NOT a shortcut-registry entry (that bar announces the
                 canvas context), so this tip is the only thing that can teach it — and
                 an unannounced double-click is exactly the defect the canvas half of
                 this pass fixed. The tip also carries SIZE + AGE, which the server
                 already sends in the same listing object (server.py: {name, size,
                 mtime, kind, url}) and which appear nowhere else in the app: they
                 answer "which of these near-identical files is the one I want".

                 THE TOOLTIP WRAPS THE WHOLE CELL, not just .ae-tile: .ae-name is
                 ellipsized (app.css), so hovering a truncated name — the most
                 natural way to try to read a truncated name — used to give nothing,
                 because the label sat outside this wrapper.

                 anchor="element" IS THE PLACEMENT RULING ("the tooltip should never
                 be intersecting [the asset]… fully below or fully above"): it pins the
                 tip to this cell's rect instead of to the cursor, so it sits wholly
                 above or wholly below and can never cover the thumbnail whose name it
                 is reporting. Tooltip flips sides by available room, which is what
                 makes a bottom-row tile's tip go UP. -->
            <Tooltip anchor="element">
              {#snippet tip()}
                {@const parts = assetTipParts(a, listedNowMs)}
                <div class="ae-tip-name">{parts.name}</div>
                <div class="ae-tip-meta">{parts.meta}</div>
                <div class="ae-tip-desc">{parts.description}</div>
              {/snippet}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="ae-tile" draggable="true" ondragstart={(e) => onTileDragStart(e, a)}>
                <!-- Generalized tile media + badge (manifest #25): image/video
                     real thumbnails, a cached-or-rasterized PDF first-page preview
                     with a page-count badge, else the kind glyph. See AssetThumb /
                     assetThumbnail.js. onclick is a no-op (double-click below owns
                     the preview open). -->
                <AssetThumb {app} asset={a} onclick={() => {}} />
                <!-- DOUBLE-CLICK, dispatched on kind (onTileDoubleClick): a PLUGIN
                     asset opens the Monaco JavaScript editor (user ruling), a DATA
                     asset opens the virtualized table, everything else opens the
                     media preview. The aria-label names the actual outcome — a
                     button announced as "Preview" that opens a code editor is a
                     screen-reader lie, and this is the same sentence the tooltip's
                     doubleClickClause tells a sighted user. -->
                <button
                  class="ae-tile-hit"
                  aria-label={`${a.name} — ${doubleClickClause(a.kind)}`}
                  ondblclick={() => onTileDoubleClick(a)}
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
                <!-- THE ALWAYS-PRESENT ACTION ROW along the tile's bottom edge:
                     copy-path, DOWNLOAD, trash. One flex row rather than three
                     absolutely-positioned corners, because the download button (user
                     ruling: "there should also always be a download icon") is the
                     THIRD always-present action and a square tile has only two bottom
                     corners — the third would have had to overlap one of the others or
                     move to the top-left, where the PDF page-count badge already
                     lives. A row also keeps the three reading in one predictable order
                     instead of the user hunting corners. The insert affordance stays in
                     its own top-right corner: it is image-only, so it is not part of
                     this always-present set. -->
                <div class="ae-tile-actions">
                  <Tooltip text={justCopiedUrl === a.url ? "Copied!" : "Copy served path to clipboard"}>
                    <button
                      class="btn-icon ae-copy-path"
                      aria-label={justCopiedUrl === a.url ? `Copied path for ${a.name}` : `Copy path for ${a.name}`}
                      onclick={() => copyAssetPath(a)}
                    >
                      <iconify-icon icon={justCopiedUrl === a.url ? "mdi:check" : "mdi:content-copy"} width="14" height="14"></iconify-icon>
                    </button>
                  </Tooltip>
                  <!-- DOWNLOAD — reads the bytes through the asset STORE (or, for a
                       built-in, its bundled source) so it works in BOTH http and
                       IndexedDB modes; see downloadAsset. -->
                  <Tooltip text={downloadTip(a)}>
                    <button
                      class="btn-icon ae-download"
                      aria-label={`Download ${a.name}`}
                      onclick={() => downloadAsset(a)}
                    >
                      <iconify-icon icon="mdi:download" width="14" height="14"></iconify-icon>
                    </button>
                  </Tooltip>
                  <!-- The tip states WHICH of the trash can's two outcomes a click
                       will take (see deleteTip): an unreferenced asset is deleted
                       immediately and irreversibly, a referenced one asks first.
                       A BUILT-IN HAS NO TRASH CAN AT ALL. It is not stored in the
                       project, so there is nothing to delete: the button used to be
                       rendered anyway and called deleteProjectAsset on a file the
                       backend has never heard of, which 404'd — the same
                       "a built-in tile is not a project asset" defect as the
                       double-click 404. Absent beats disabled here: an affordance that
                       could never do anything should not occupy the row. -->
                  {#if !a.builtin}
                    <Tooltip text={deleteTip(a.name, assetUserCounts.get(a.name) ?? 0)}>
                      <button
                        class="btn-icon ae-trash"
                        aria-label={`Delete ${a.name}`}
                        onclick={() => onTrashClick(a)}
                      >
                        <iconify-icon icon="mdi:trash-can-outline" width="14" height="14"></iconify-icon>
                      </button>
                    </Tooltip>
                  {/if}
                </div>
              </div>
              <div class="ae-name">{a.name}</div>
            </Tooltip>
          </div>
        {/each}
      </div>
  {/snippet}
</div>

<!-- THE ONE PREVIEW SURFACE, extended rather than forked: a DATA asset gets a
     fourth branch here (a virtualized table) beside image/video/audio, so
     "view a CSV just like we can view other assets" is literally the same
     dialog, opened by the same double-click, titled with the same filename. -->
<Modal bind:open={previewOpen} title={preview?.name ?? ""}>
  {#if preview?.kind === "image"}
    <img class="ae-preview-media" src={urlOf(preview)} alt={preview.name} />
  {:else if preview?.kind === "video"}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="ae-preview-media" src={urlOf(preview)} controls autoplay></video>
  {:else if preview?.kind === "sound"}
    <audio class="ae-preview-media" src={urlOf(preview)} controls autoplay></audio>
  {:else if preview?.kind === "data"}
    <!-- The text arrives through the asset STORE (loadPreviewText), so this works
         in HTTP and IndexedDB modes alike. Three states, all of them stated: a
         failure names itself, a load in flight says it is loading, and only real
         text becomes a table — an empty table standing in for a failed read is
         exactly the silent-wrong-answer this pane refuses elsewhere. -->
    {#if previewTextError}
      <div class="ae-notice ae-error">
        <div class="ae-notice-title">Couldn't read this file</div>
        <div class="ae-notice-detail">{previewTextError}</div>
      </div>
    {:else if previewText === null}
      <div class="ae-notice">Reading {preview.name}…</div>
    {:else}
      <CsvTable text={previewText} filename={preview.name} />
    {/if}
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
