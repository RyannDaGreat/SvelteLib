<!--
  CanvasView — the zoomable editing canvas.

  Composition: SvelteLib PanZoom (headless viewport) wrapping a <canvas>
  (scene, painted by render/compositor.js) and an <svg> overlay (selection
  outline, resize handles, snap/axis guides, anchor X's, arrow endpoints).
  All drag math runs in WORLD space through PanZoom's screenToWorld — one
  tested transform for drags, guides, hit-tests, and snapping alike
  (the Pixel-Aligner lesson).
-->
<script>
  import { onDestroy } from "svelte";
  import PanZoom from "../../../lib/PanZoom.svelte";
  import MiniMap from "../../../lib/MiniMap.svelte";
  import ResizeHandles from "./ResizeHandles.svelte";
  import { pickNode, nodeFeatures, nodeAnchors, nodeModifierPoints, isGhostNode, deriveRenderTree, cameraRect, worldTransform, stateXYForCenterPivotWorld, groupMembership, snapExclusionSet } from "../core/derive.js";
  import { solveSnap, solveEdgeSnap, sizeMatches, axisLock, provenanceAnchorId, anchorSnapEquation, resizeEdgeEquation } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  import { worldViewRect, canSkipNode } from "../core/view.js";
  import { selectInBox, rectFromCorners } from "../core/bandselect.js";
  import { sceneIR } from "../render_gpu/ports.js";
  import { preRasterizePdfPages } from "../render_gpu/pdf_display.js";
  import { rect as rectCmd, parseColor } from "../render_gpu/ir.js";
  import { SkiaSurface } from "../render_gpu/skia/browser_surface.js";
  import { onImageLoad } from "../render_gpu/gpu/image_registry.js";
  import { onVideoFrame } from "../render_gpu/gpu/video_registry.js";
  import { renderCameraFrame } from "./gpuService.js";
  import { cameraRectAt } from "./cameraFrame.js";
  import * as T from "../core/transform.js";
  // Extracted pure drag geometry (manifest UNDEFERRAL SWEEP: CanvasView
  // drag-machine extraction — PARTIAL: the stateless math; the stateful per-kind
  // handlers stay here). See web/canvas/dragKinds.js + tests/dragkinds_test.js.
  import { translationPairs, resizeAnchors, resizedBox, scaleMemberPairs, scalePairs, groupResizeState, creationRect, creationEndpoint } from "./canvas/dragKinds.js";
  import { visibleLevels, ticksInRange } from "../../../lib/ticks.js";
  import { ASSET_DRAG_MIME } from "./projectApi.js"; // asset-tile drop payload type (drop-handler region)
  import TextEditController from "./TextEditController.svelte"; // TRUE in-place rich-text editor (Skia-owned caret/selection)

  let { app } = $props();

  const SNAP_PX = 8; // THE one uniform snap threshold (user rule): drag snap, resize snap, anchor bind, border grab (value PENDING USER RATIFICATION)
  // (MIN_SIZE = 0 — the non-negative-size bound — now lives with resizedBox in
  // ./canvas/dragKinds.js, its only reference; removed here as dead code.)
  // Click-vs-drag slop for shift-click multi-select: a shift+pointer-down that
  // is RELEASED before the pointer moves this many screen px is a CLICK (toggles
  // selection membership); crossing it makes the gesture a shift-DRAG (axis-lock,
  // selection untouched). LINKED to the identical click-vs-drag distinction in
  // AnnotateBar.svelte:255 / DraggableNumber.svelte:138 (CLICK_SLOP_PX = 4) —
  // the house pointer-gesture slop; one value, one precedent (user rule: no
  // arbitrary invented constants). Measured in SCREEN px so zoom doesn't change
  // the feel.
  const CLICK_SLOP_PX = 4;

  let containerEl = $state(null);
  let canvasEl = $state(null);
  let overlayEl = $state(null); // the pointer-capturing SVG; fills the PanZoom container (render-area frame origin)
  let gridEl = $state(null); // underlay canvas for the Blender-style grid (beneath .scene)
  let wrapW = $state(0);
  let wrapH = $state(0);
  // THE ONLY stored mouse truth: the raw SCREEN-space pointer position in the
  // PanZoom container's frame (px from its top-left), or null when off-canvas.
  // Every world-space mouse value is a $derived over (screenMouse, viewport) —
  // so zoom/pan under a stationary cursor updates the readout by construction
  // (manifest "Zoom/pan mouse invalidation"), for this and all future consumers.
  let screenMouse = $state(null); // {x, y} in PanZoom-container px, or null

  // Ruler target spacing = the ONE control-height token so labels never crowd
  // (min gap between labelled ticks). Read once from CSS; falls back if unset.
  const RULER_TARGET_PX = 56; // ~2x the 26px control height — comfortable label gap

  /**
   * Pure function. Fading ruler ticks for one axis: the SAME partition-of-unity
   * level fades as the grid (visibleLevels), so ticks/labels cross-fade with
   * zoom instead of popping (user ruling). Each world position keeps the MAX
   * opacity among the levels containing it (a coarse tick is also a fine tick).
   *
   * @example // rulerTicks(0, 100, 1, toS) → [{w, s, opacity}, ...]
   */
  function rulerTicks(worldLo, worldHi, zoom, toScreen) {
    const byW = new Map();
    for (const lvl of visibleLevels(zoom, RULER_TARGET_PX))
      for (const w of ticksInRange(worldLo, worldHi, lvl.spacing)) {
        const key = w.toFixed(6); // float-slack key only
        const prev = byW.get(key);
        if (!prev || lvl.opacity > prev.opacity) byW.set(key, { w, s: toScreen(w), opacity: lvl.opacity });
      }
    return [...byW.values()];
  }

  let rulerX = $derived.by(() => {
    viewport; wrapW;
    if (!actions || !containerEl || !(viewport.zoom > 0)) return [];
    const rect = containerEl.getBoundingClientRect();
    const lo = (0 - viewport.panX) / viewport.zoom;
    const hi = (rect.width - viewport.panX) / viewport.zoom;
    return rulerTicks(lo, hi, viewport.zoom, (w) => actions.worldToScreen(w, 0).x);
  });

  let rulerY = $derived.by(() => {
    viewport; wrapH;
    if (!actions || !containerEl || !(viewport.zoom > 0)) return [];
    const rect = containerEl.getBoundingClientRect();
    const lo = (0 - viewport.panY) / viewport.zoom;
    const hi = (rect.height - viewport.panY) / viewport.zoom;
    return rulerTicks(lo, hi, viewport.zoom, (w) => actions.worldToScreen(0, w).y);
  });

  // World point under the cursor — DERIVED from the stored screen position and
  // the current view, so panning/zooming under a still cursor updates it.
  let mouseWorld = $derived.by(() => {
    viewport;
    if (screenMouse == null || !actions) return null;
    return actions.screenToWorld(screenMouse.x, screenMouse.y);
  });
  // Screen positions of the live mouse marker on each ruler (null = off-canvas).
  // The marker sits at the SAME screen x/y the pointer is at — worldToScreen ∘
  // screenToWorld is identity, so these equal screenMouse; expressed through the
  // view transform to keep every ruler value in the one (world↔screen) frame.
  let mouseMarkerX = $derived(mouseWorld == null ? null : actions.worldToScreen(mouseWorld.x, 0).x);
  let mouseMarkerY = $derived(mouseWorld == null ? null : actions.worldToScreen(0, mouseWorld.y).y);
  let minimapThumb = $state(""); // data URL of the current slide's CAMERA frame, for the minimap
  // The current slide's camera rect (world space) — the minimap's world bounds
  // AND the placement of its content image (rebased off the raw slide rect;
  // cruft audit #2). Committed state only (never the drag preview), matching the
  // thumbnail freeze: the minimap tracks committed edits, not drag churn.
  let minimapCamRect = $derived(cameraRectAt(app.doc, app.slideIndex, 1, app.registry));
  let viewport = $state({ zoom: 1, panX: 0, panY: 0 });
  // PanZoom actions — deliberately NOT $state: it's bound during template
  // render (mutating $state there is forbidden), and every overlay that needs
  // it is also gated on reactive state (selection/guides/viewport) that can
  // only change after actions is bound.
  let actions = null;
  let guides = $state([]); // world-space guide descriptors from snap/axis lock
  // Matching-dimension indicators (Figma-style): world-space two-way arrows
  // spanning each object whose width/height matches the resizing item's.
  // {axis: "w"|"h", x, y, w, h} — the AABB the arrow is drawn across.
  let sizeIndicators = $state([]);
  // Anchor under the pointer → immediate SVG-native tooltip naming it
  // (HTML Tooltip can't nest inside <svg>). {label, x, y} in world coords.
  // During an ENDPOINT drag this is the live bind candidate (manifest Anchor
  // UX: the nearest bindable anchor shows its referencable name mid-drag).
  let hoverAnchor = $state(null);
  // Computed ("dynamic") anchor candidate during an endpoint drag — a point
  // that is a live FUNCTION (the closest-point-on-perimeter tracking the
  // dragged endpoint), not a fixed preset: rendered as a # glyph, vs the
  // preset anchors' X. {x, y} world coords, or null.
  let dynamicAnchor = $state(null);
  // In-progress rubber-band selection (armed via the palette "Select in Box"
  // commands): the world-space band rect and the itemIds the current box
  // would select (live preview — outlined before release so the user sees
  // exactly what a drop selects). Both cleared on pointer-up.
  let bandRect = $state(null); // {x, y, w, h} world, or null
  let bandCandidates = $state([]); // itemIds the current band would select
  // In-progress CROSSHAIR PLACEMENT preview (manifest ARCHITECTURE PLAN #5):
  // the world-space rect a drag-placement is about to create. Null outside a
  // placement drag (a plain click never sets it — see placementUp).
  let placeRect = $state(null); // {x, y, w, h} world, or null
  // In-progress ENDPOINT-placement preview (arrow-family Add buttons, manifest
  // UNDEFERRAL SWEEP): the world-space from→to segment a drag-placement is about
  // to create. Null outside an endpoint placement drag (and for bbox placements,
  // which use placeRect instead).
  let placeLine = $state(null); // {x1, y1, x2, y2} world, or null
  // ── TRUE IN-PLACE TEXT EDIT (Skia-owned caret/selection) ────────────────────
  // Edit state lives on the app store (app.textEditing = {itemId}) so the
  // controller and the shortcut context read the ONE source of truth. paint()
  // never suppresses the edited item — Skia draws it live; the TextEditController
  // (in the template) self-draws the caret/selection from the SAME Paragraph the
  // render uses. onDblClick just calls app.beginTextEdit; the controller owns the rest.
  // A-key live state (manifest ARCHITECTURE PLAN #4 "ANCHOR SNAP"): tracked
  // via window keydown/keyup (not e.getModifierState, which has patchy
  // cross-browser support for letter keys) so onPointerUp — which fires no
  // keyboard event of its own — can read "was A held at release". Reactive
  // only through app.snapEngaged's existing HintBar wiring below; this flag
  // itself stays non-reactive bookkeeping, like `drag`/`modal`, since nothing
  // paints from it directly (the HintBar hint is keyed on snapEngaged, not on
  // whether A specifically is down).
  let aHeld = false;
  let drag = null; // non-reactive drag bookkeeping
  // Image decodes are async while the reactive paint is sync — a resolved
  // bitmap must nudge a repaint (Opus8's flagged seam; the PRESENTER needs no
  // nudge, its rAF loop repaints anyway). onImageLoad returns the
  // unsubscriber, which $effect uses as its cleanup.
  let imageEpoch = $state(0);
  $effect(() => onImageLoad(() => (imageEpoch += 1)));
  // Playing videos repaint per decoded frame (requestVideoFrameCallback via
  // the registry) — same epoch, same reason (reactive paint, async frames).
  $effect(() => onVideoFrame(() => (imageEpoch += 1)));
  // Active Blender-style modal transform bookkeeping (non-reactive, like drag).
  // {kind: "grab"|"scale", startWorld, members, center, axis, buffer}. Started
  // when app.modalXform is set (G/S shortcut) and captured by the effect below;
  // the pointer follows it with NO button held. `axis` (null|"x"|"y") is the
  // Blender-style constraint (X/Y keys); `buffer` is the typed numeric string
  // (digits/./-, applied EXACTLY, pointer-independent while non-empty). Both
  // are mirrored into the reactive app.modalXform on every change so the HintBar
  // announces the live mode/axis/buffer. World-space scale pivot for the overlay
  // (a guide-point during scale) — cleared with the modal.
  let modal = null;
  let modalCenter = $state(null); // {x, y} world — the scale pivot dot, or null

  // Repaint whenever anything visible changes — INCLUDING the container size
  // (wrapW/wrapH), so pane resizes re-render instead of stretching the bitmap.
  // THE renderer (2026 render rewrite): the content canvas is Skia (CanvasKit)
  // on WebGL2 — which, unlike WebGPU, needs no secure context, so the editor
  // renders over plain HTTP (LAN IP, etc.). Init is async; the first paint fires
  // when `gpu` lands (it's a dep of the paint effect). Failure is LOUD and
  // user-visible.
  let gpu = $state(null);
  let gpuError = $state(null);
  $effect(() => {
    if (!canvasEl || gpu || gpuError) return;
    // premultiplied alpha: the transparent clear must show the grid underlay +
    // app background beneath the canvas (opaque would render it black).
    SkiaSurface.create(canvasEl)
      .then((g) => (gpu = g))
      .catch((e) => {
        gpuError = String(e?.message ?? e);
        console.error("PowerRP: Skia/WebGL init failed:", e);
      });
  });
  // Free the Skia/WebGL surface on teardown (remount / HMR / project switch):
  // each SkiaSurface owns a WebGL2 context + GrContext + GL surface, which leak
  // without an explicit dispose (SkiaSurface.dispose).
  onDestroy(() => gpu?.dispose());

  $effect(() => {
    app.doc; app.slideIndex; app.previewDelta; app.anchorsVisible; viewport; wrapW; wrapH; gpu; imageEpoch;
    paint();
  });

  // Minimap content: the current slide's CAMERA FRAME (through the camera, like
  // the slide thumbnails — renderCameraFrame), rebased off the old raw-slide
  // view (cruft audit #2). Rendered at the minimap's displayed content size ×
  // dpr (retina), CAMERA-RECT aspect — no fixed THUMB_W upscale. Skipped while
  // dragging (previewDelta churn) — refreshed on commit. Async: last write wins.
  // MINIMAP_MAX_PX is the MiniMap component's own maxSize default (src/lib/
  // MiniMap.svelte) — the longest CSS edge the content is displayed at; linked,
  // not invented (user rule: base constants on precedent).
  const MINIMAP_MAX_PX = 150;
  $effect(() => {
    app.doc; app.slideIndex; app.minimapVisible; minimapCamRect; imageEpoch;
    if (!app.minimapVisible || app.previewDelta) return;
    const rect = minimapCamRect;
    if (!(rect.w > 0 && rect.h > 0)) return; // degenerate camera → no thumbnail
    const dpr = app.dpr(); // retina browser setting (manifest)
    // Fit the camera-rect aspect into a MINIMAP_MAX_PX box (the displayed size),
    // then × dpr so it is exactly as crisp as the screen shows it.
    const scale = MINIMAP_MAX_PX / Math.max(rect.w, rect.h);
    const width = Math.max(1, Math.round(rect.w * scale * dpr));
    const height = Math.max(1, Math.round(rect.h * scale * dpr));
    renderCameraFrame(app.doc, {
      slideIndex: app.slideIndex,
      alpha: 1,
      registry: app.registry,
      width,
      height,
    }).then((thumb) => (minimapThumb = thumb.toDataURL("image/png")));
  });

  function paint() {
    if (!canvasEl || !containerEl || !gpu) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const rect = containerEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // collapsed pane → a 0×0 GL surface is null (skip)
    if (canvasEl.width !== Math.round(rect.width * dpr) || canvasEl.height !== Math.round(rect.height * dpr)) {
      canvasEl.width = Math.round(rect.width * dpr);
      canvasEl.height = Math.round(rect.height * dpr);
    }
    // THE render pipeline: fold → preview override → EVALUATE → derive →
    // cull → emit → GPU. Anchors/selection/guides stay on the SVG overlay.
    // fold/blend/evaluate route through app.state() so the paint shares the
    // ONE memoized evaluation per pointermove with every panel consumer
    // (inlining them here allocated a fresh blend per frame — a full extra
    // equation pass; the drag-lag fix, concerns 2026-07-15).
    const state = app.state();
    const view = { ...viewport, dpr };
    const viewRect = worldViewRect(view, canvasEl.width, canvasEl.height);
    // TRUE IN-PLACE EDITING (Skia-owned caret/selection): the item being edited is
    // drawn through Skia LIKE ANY OTHER — no suppression. Its shadow/glow/border/
    // exact layout are therefore what the user SEES while editing, and they update
    // live per keystroke because app.previewTextValue → app.previewDelta (a dep of
    // this paint effect) re-blends the text leaf every input. The TextEditController
    // draws the caret/selection ON TOP from the SAME CanvasKit Paragraph the render
    // uses, so they land on the glyphs across mixed runs — no double image, and no
    // exit "jump" (the Skia render is identical during and after the edit).
    const nodes = deriveRenderTree(state, app.registry)
      .filter((n) => !canSkipNode(n, viewRect));
    // The camera's background shows in the editor too (round 11: "I can't
    // see it in the main editing area") — first draw, under all content;
    // outside the camera bbox the transparent clear keeps the app background
    // visible, exactly like the old clearRect + canvas2D path.
    const camRect = cameraRect(state, app.doc.meta);
    // PDF DISPLAY RE-RASTER (manifest RENDER PIVOT): before building the IR,
    // ensure every visible PDF page's ON-SCREEN region is rasterized at THIS
    // zoom (crisp at any magnification, cost bounded by the viewport). Returns
    // the per-item display descriptor map sceneIR threads into pdf_page emit();
    // the region raster registers into the image registry, so onImageLoad
    // (imageEpoch, above) already wakes the repaint when it lands.
    // `window.__powerrp_noPdfReraster` is a dev/test seam (mirrors
    // window.__powerrp_app): when set, the re-raster is skipped so a probe can
    // capture the OLD whole-page-raster look for a before/after comparison. It
    // has ZERO effect in production (nothing sets it).
    const pdfDisplay = window.__powerrp_noPdfReraster
      ? null
      : preRasterizePdfPages(nodes, view, canvasEl.width, canvasEl.height);
    const ir = [
      rectCmd({ x: camRect.x, y: camRect.y, w: camRect.w, h: camRect.h, fill: parseColor(camRect.background) }),
      ...sceneIR(nodes, { pdfDisplay }),
    ];
    gpu.render(ir, view, { background: [0, 0, 0, 0] });
    app.renderFrameCount += 1;
  }

  // Blender-style background grid on a SEPARATE underlay canvas beneath .scene —
  // editor-only chrome, never touching the compositor. Repaints on the same
  // reactive deps as the scene (viewport, size, toggle, theme for line color).
  $effect(() => {
    viewport; wrapW; wrapH; app.gridEnabled; app.theme;
    paintGrid();
  });

  /**
   * Command (draws to the underlay canvas). Paints the multi-level decade grid:
   * each visible decade level's lines at its per-level fade opacity, so the
   * composite reads as one continuous grid at any zoom (ticks.js math). Cleared
   * (and skipped) when the grid option is off. Line color derives from --fg at
   * low alpha via CSS color-mix — theme-aware, no hardcoded color.
   */
  function paintGrid() {
    if (!gridEl || !containerEl) return;
    const dpr = app.dpr();
    const rect = containerEl.getBoundingClientRect();
    if (gridEl.width !== Math.round(rect.width * dpr) || gridEl.height !== Math.round(rect.height * dpr)) {
      gridEl.width = Math.round(rect.width * dpr);
      gridEl.height = Math.round(rect.height * dpr);
    }
    const ctx = gridEl.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!app.gridEnabled || !(viewport.zoom > 0)) return;

    const cs = getComputedStyle(containerEl);
    const base = cs.getPropertyValue("--a-grid-line").trim() || cs.getPropertyValue("--fg").trim() || "#888";
    const worldLoX = (0 - viewport.panX) / viewport.zoom;
    const worldHiX = (rect.width - viewport.panX) / viewport.zoom;
    const worldLoY = (0 - viewport.panY) / viewport.zoom;
    const worldHiY = (rect.height - viewport.panY) / viewport.zoom;
    ctx.lineWidth = 1; // hairline in CSS px (dpr scaling already applied via setTransform)

    // Coarse levels drawn after fine ones so their (equal or stronger) lines sit
    // on top; opacity handles the visual weighting either way.
    for (const lvl of visibleLevels(viewport.zoom, RULER_TARGET_PX)) {
      ctx.globalAlpha = lvl.opacity;
      ctx.strokeStyle = base;
      ctx.beginPath();
      for (const wx of ticksInRange(worldLoX, worldHiX, lvl.spacing)) {
        const sx = Math.round(wx * viewport.zoom + viewport.panX) + 0.5; // crisp 1px line
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, rect.height);
      }
      for (const wy of ticksInRange(worldLoY, worldHiY, lvl.spacing)) {
        const sy = Math.round(wy * viewport.zoom + viewport.panY) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(rect.width, sy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // PanZoom → our state (also parks actions on the app for commands like Reset
  // View, and the latest viewport so undo snapshots can restore the view).
  function onviewport(vp) {
    viewport = vp;
    app.lastViewport = vp;
  }
  function bindActions(a) {
    actions = a;
    app.canvasActions = a;
    return "";
  }

  // Screen point in the PanZoom (render-area) frame — the SAME frame
  // screenToWorld/worldToScreen and the ruler SVGs live in. Measured off the
  // overlay, which fills the PanZoom container exactly (inset:0); when rulers
  // are chrome OUTSIDE the render area, the overlay rect (not .canvas-wrap)
  // is the render-area origin, so every mouse value stays in ONE frame.
  function screenPoint(e) {
    const rect = overlayEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function worldPoint(e) {
    const s = screenPoint(e);
    return actions.screenToWorld(s.x, s.y);
  }

  /**
   * The snap CANDIDATE nodes for the current single-item drag: every node
   * EXCEPT the dragged item's own group relation (manifest 15.7 SNAP EXCLUSION —
   * a member never snaps to its group's outline/anchors, a group never snaps to
   * its own members' features, both directions). Generalizes the old
   * `n.itemId !== drag.itemId` self-exclusion via core snapExclusionSet (self +
   * own group + own members); snapping to OTHER groups/items is unchanged.
   */
  function snapCandidates(nodes) {
    const excluded = snapExclusionSet(drag.itemId, groupMembership(nodes), nodes);
    return nodes.filter((n) => !excluded.has(n.itemId));
  }

  // ── Asset / OS-file drop (drop-handler region — manifest Round 12C) ─────────
  // An asset tile dragged from the Asset Explorer, or a file dragged from the
  // OS, inserts AT THE DROP POINT (media centered there, native pixel size).
  // The tile payload rides our own MIME type (set by AssetExplorer ondragstart);
  // an OS drag carries Files — nothing else is accepted. Media inserts route
  // through app.insertImageAsset / app.insertVideoAsset; OS files are first
  // UPLOADED to the project (the pane's own upload path, app.uploadAsset) and
  // then inserted. Kinds with no canvas widget (sound/other) still upload —
  // they appear in the asset library — and the no-widget case is reported.

  function dropAccepts(dt) {
    const types = dt?.types ?? [];
    return types.includes(ASSET_DRAG_MIME) || types.includes("Files");
  }

  function onCanvasDragOver(e) {
    if (!dropAccepts(e.dataTransfer)) return; // not ours — default (rejects the drop)
    e.preventDefault(); // required, or the browser never fires drop
    e.dataTransfer.dropEffect = "copy";
  }

  /**
   * Pure function. Asset kind of a dropped OS File by MIME prefix (the client
   * mirror of the server's extension-based asset_kind).
   *
   * @example fileKind({type: "image/png"})  // "image"
   * @example fileKind({type: "video/mp4"})  // "video"
   * @example fileKind({type: "audio/wav"})  // "sound"
   * @example fileKind({type: "text/plain"}) // "other"
   */
  function fileKind(file) {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "sound";
    return "other";
  }

  /** Command. Insert one asset ({name, kind, url}) centered at world point
   *  `at`. Kinds without a canvas widget are reported, never silently dropped. */
  async function insertDroppedAsset(asset, at) {
    if (asset.kind === "image") return app.insertImageAsset(asset.url, at);
    if (asset.kind === "video") return app.insertVideoAsset(asset.url, at);
    console.warn(`Canvas drop: no canvas widget for a "${asset.kind}" asset (${asset.name}) — it stays in the asset library.`);
  }

  /** Command. The canvas drop: asset-tile payload → insert at the drop point;
   *  OS files → upload each, then insert at the drop point. A failure in any
   *  step is REPORTED loudly (console.error) — a user gesture must never fail
   *  silently, and an event handler has no caller to rethrow to. */
  async function onCanvasDrop(e) {
    if (!dropAccepts(e.dataTransfer)) return;
    e.preventDefault();
    // Read the DataTransfer SYNCHRONOUSLY — browsers neuter it once the
    // handler yields, so the payload and file list are captured up front.
    const payload = e.dataTransfer.getData(ASSET_DRAG_MIME);
    const files = [...e.dataTransfer.files];
    const at = worldPoint(e); // world-space drop point (render-area frame)
    try {
      if (payload) return await insertDroppedAsset(JSON.parse(payload), at);
      for (const file of files) {
        const up = await app.uploadAsset(file); // {ok, name, url}
        await insertDroppedAsset({ name: up.name, kind: fileKind(file), url: up.url }, at);
      }
    } catch (err) {
      console.error("Canvas drop failed:", err);
    }
  }

  // ── DBLCLICK TEXT EDIT → TRUE in-place editor (Skia-owned caret/selection) ──
  // Double-clicking a TEXT widget enters IN-PLACE edit mode: Skia keeps rendering
  // the item (shadow/effects/exact layout, live per keystroke) and the
  // TextEditController draws the caret/selection ON TOP from the SAME CanvasKit
  // Paragraph the render uses (glyph-accurate across mixed runs), with a hidden
  // input sink for keys/IME/clipboard — so what the user SEES is the real render,
  // no double image, no exit jump. The controller + floating toolbar own the whole
  // edit lifecycle (preview/commit/cancel, per-run + per-paragraph style, Ctrl+B/
  // I/U, Cmd±); this handler just ENTERS it.

  /** Command. Enters in-place edit mode on the double-clicked TEXT widget (if any).
   *  Non-text targets fall through (a dblclick on a rect does nothing). */
  function onDblClick(e) {
    if (drag || modal) return; // never open mid-gesture
    const w = worldPoint(e);
    const hit = pickNode(app.nodes(), w.x, w.y, SNAP_PX / viewport.zoom);
    if (hit?.type !== "text") return;
    app.beginTextEdit(hit.itemId); // selects + mounts the controller (Skia keeps drawing the item)
  }

  // ── Selection + drag ────────────────────────────────────────────────────────

  /**
   * The translatable members of the current selection, each captured with the
   * data a body-drag/modal-grab needs: its plugin, its RAW stored item (so
   * equation-bound coords are recognized as strings and stay anchored), its
   * numeric start x/y, and its start WORLD transform + w/h (the exact
   * rotation-aware scale needs the pivoted world, not the base-frame x/y —
   * see scalePairs). Shared by DRAG-ALL and the G/S modal transforms so the
   * two never disagree on what "the selection" is. A member qualifies exactly
   * like a single body-drag target: transform (bbox x/y) OR a moveBy hook
   * (arrow shafts) — everything else in the set (blur, etc.) is simply not
   * moved. `nodes` is the current derived tree (already evaluated).
   */
  function translateMembers(nodes) {
    const ids = new Set(app.selectedIds());
    const raw = app.rawState().items ?? {};
    return nodes
      .filter((n) => ids.has(n.itemId) && (n.plugin.capabilities.transform || n.plugin.moveBy))
      .map((n) => ({
        itemId: n.itemId,
        plugin: n.plugin,
        rawItem: raw[n.itemId],
        startX: n.state.x ?? 0,
        startY: n.state.y ?? 0,
        // Start world transform + local box size — the exact scale-about-center
        // (scalePairs) needs the FOLDED world (rotation pivot included), since a
        // rotated item's world top-left ≠ its stored x/y.
        startWorld: n.world,
        startW: n.state.w ?? 0,
        startH: n.state.h ?? 0,
      }));
  }

  // translationPairs / resizeAnchors / resizedBox / scaleMemberPairs / scalePairs
  // are imported from ./canvas/dragKinds.js (the extracted pure drag geometry).

  function onPointerDown(e) {
    if (e.button !== 0 || app.mode !== "edit") return;
    // A left click CONFIRMS an active modal transform (Blender precedent) and
    // consumes the event — it must NOT start a new pick/drag underneath.
    if (modal) {
      commitModal();
      return;
    }
    const w = worldPoint(e);
    // An armed CROSSHAIR (manifest ARCHITECTURE PLAN #5) consumes the
    // ONE-SHOT arm on the first pointer-down: "band" starts the rubber-band
    // drag kind below (mode already resolved at arm time — "regular" →
    // bandMode); "place" starts the placement drag kind. Both clear the arm
    // immediately (one-shot) so a second gesture needs a fresh arm/command.
    if (app.crosshair) {
      const armed = app.crosshair;
      e.currentTarget.setPointerCapture(e.pointerId);
      app.crosshair = null;
      hoverAnchor = null; // a hover tip must not linger frozen through the drag
      app.dragging = true;
      if (armed.kind === "band") {
        drag = { kind: "band", mode: armed.mode, startWorld: w, lastWorld: w };
        bandRect = rectFromCorners(w, w);
        bandCandidates = [];
        app.dragKind = "band";
      } else {
        // downScreen/moved: the SAME click-vs-drag slop tracking every other
        // drag kind uses (onPointerMove, CLICK_SLOP_PX) — a placement that
        // never crosses it is a CLICK (default-size/length placement); crossing
        // it makes it a DRAG (exact rect / exact from→to). See placementUp.
        // The START point snaps HERE, at arm/grab time (manifest 13.2: "both
        // the start point and the live drag point") — not deferred to the
        // first pointermove, so it applies even to a plain CLICK placement
        // (no move ever fires) and so guides/snapEngaged appear immediately
        // rather than one move-event later.
        const snappedStart = snapPoint(w.x, w.y);
        guides = snappedStart.guides;
        drag = { kind: "place", plugin: armed.plugin, startWorld: { x: snappedStart.x, y: snappedStart.y }, startGuides: snappedStart.guides, lastWorld: w, downScreen: screenPoint(e), moved: false };
        // Endpoint-kind (arrows) previews a from→to LINE; bbox-kind a rect.
        if (armed.plugin.placement === "endpoints") placeLine = { x1: drag.startWorld.x, y1: drag.startWorld.y, x2: drag.startWorld.x, y2: drag.startWorld.y };
        else placeRect = rectFromCorners(drag.startWorld, drag.startWorld);
        app.dragKind = "place";
      }
      return;
    }
    const nodes = app.nodes();
    const hit = pickNode(nodes, w.x, w.y, SNAP_PX / viewport.zoom);
    // DEFAULT EMPTY-SPACE DRAG = BOX SELECT (manifest Round 12B "Box select
    // round 2"): a pointer-down that hits nothing draggable AND nothing at
    // all (camera background is a non-hit — camera.hitTest is border-only —
    // and so is the empty canvas) starts a band drag DIRECTLY, no arming
    // needed, at the default bandMode. Shift is EXCLUDED here on purpose: a
    // shift+down on empty canvas must keep falling through to the existing
    // "keeps the selection" branch below (a shift-click-empty spec this task
    // must not disturb) rather than starting a band — band-select's OWN shift
    // semantics (deselect-caught, see bandDrag/onPointerUp) only apply to a
    // gesture that is unambiguously a band drag from the start (toolbar/
    // palette-armed, or this empty-space default with no modifier).
    if (!e.shiftKey && !hit) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag = { kind: "band", mode: app.bandMode, startWorld: w, lastWorld: w };
      bandRect = rectFromCorners(w, w);
      bandCandidates = [];
      hoverAnchor = null;
      app.dragging = true;
      app.dragKind = "band";
      return;
    }
    // Shift disambiguation (manifest "Shift-click multi-select"): Shift is BOTH
    // the axis-lock modifier AND the multi-select add/remove modifier, so a
    // shift+down must NOT decide selection here — it is DEFERRED to release. If
    // the pointer stays within CLICK_SLOP_PX it was a shift-CLICK → toggle the
    // hit item's membership (or, on empty canvas, keep the selection — PPT); if
    // it crosses the slop it was a shift-DRAG → axis-lock as today, selection
    // untouched. Plain (non-shift) click keeps the eager single-select on down.
    // Plain (non-shift) pointer-down resolves the selection eagerly. Clicking an
    // item that is ALREADY part of a multi-selection KEEPS the whole set — that
    // is what lets a drag of any selected member move the WHOLE selection
    // (manifest Round 12 "DRAG-ALL"; PowerPoint/Figma precedent). Clicking any
    // OTHER item (or empty canvas) replaces the selection with just it. Shift is
    // deferred to release (toggle-vs-axis-lock — see below).
    if (!e.shiftKey && !(hit && app.selectedIds().includes(hit.itemId)))
      app.selection = hit?.itemId ?? null;
    // Draggable = has a transform (x/y) OR a moveBy hook (arrow shaft drag
    // translates its endpoints — manifest round 5: "Both must work").
    if (!hit || !(hit.plugin.capabilities.transform || hit.plugin.moveBy)) {
      // Nothing draggable under the pointer. A pending shift-click still needs a
      // gesture record so onPointerUp can toggle on release (with no capture,
      // since there's no drag) — but only when there's an item to toggle; a
      // shift-click on EMPTY canvas records nothing and thus keeps the selection.
      if (e.shiftKey && hit) {
        drag = { kind: "shiftpick", toggleId: hit.itemId, downScreen: screenPoint(e), moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = {
      kind: "move",
      itemId: hit.itemId,
      plugin: hit.plugin,
      // Pending shift-click toggle: set only when Shift is down. onPointerUp
      // toggles this item's membership IFF the gesture never crossed the slop
      // (a plain shift-DRAG leaves it untouched — it's an axis-locked move).
      toggleId: e.shiftKey ? hit.itemId : null,
      downScreen: screenPoint(e),
      moved: false,
      // moveBy needs the RAW stored state: equation-bound coordinates must be
      // recognized (strings) so they stay anchored instead of translating.
      rawItem: app.rawState().items?.[hit.itemId],
      startWorld: w,
      startX: hit.state.x ?? 0,
      startY: hit.state.y ?? 0,
      // DRAG-ALL (manifest Round 12): dragging any selected member moves the
      // WHOLE selection — the move preview is built over EVERY translatable
      // member, all by the SAME (post-axis-lock, post-snap) world delta. The
      // snap probe + axis guide still run on the GRABBED item only (the
      // single-item behavior is the precedent). A lone selection makes members
      // == [grabbed], so the single-item preview shape is byte-identical (the
      // editor_smoke mid-drag invariants keep holding).
      members: translateMembers(nodes),
      // The shift axis guide anchors at the item's world CENTER (manifest
      // "Drag/resize modifiers": "the guideline should go down the middle") —
      // computed through node.world, since world.x is NOT state.x for rotated
      // items (the rotation pivot shifts the translation — Opus1 finding #2).
      // Axis lock zeroes the cross-axis delta, so the center stays ON this
      // line for the whole locked drag. Non-bbox draggables (arrow shafts)
      // have no center; their guide anchors at the grab point instead.
      centerWorld: hit.plugin.capabilities.bbox
        ? T.apply(hit.world, (hit.state.w ?? 0) / 2, (hit.state.h ?? 0) / 2)
        : null,
      axis: null,
    };
    hoverAnchor = null; // a hover tip must not linger frozen through the drag
    app.dragging = true;
    app.dragKind = "move";
  }

  function onPointerMove(e) {
    // Store ONLY the raw screen-space position (PanZoom render-area frame); the
    // ruler markers/readout are $derived from it + the view (see screenMouse).
    screenMouse = screenPoint(e);
    const w = worldPoint(e);
    // A modal transform (G/S) follows the mouse with NO button held — the
    // pointer path drives it directly and nothing else runs.
    if (modal) {
      modalMove(w);
      return;
    }
    if (!drag) {
      const nodes = app.nodes();
      // Anchor hover tooltip (immediate; only while anchors are shown).
      // Shows the anchor's REFERENCABLE name ("circle_tm") — exactly what an
      // equation types before .x/.y (THE UNIFICATION: anchors are variables).
      hoverAnchor = null;
      if (app.anchorsVisible) {
        const tol = SNAP_PX / viewport.zoom;
        let best = null;
        for (const n of nodes)
          for (const a of nodeAnchors(n)) {
            const d = Math.hypot(a.x - w.x, a.y - w.y);
            if (d <= tol && (!best || d < best.d))
              best = { d, label: app.anchorName(n.itemId, a.id), x: a.x, y: a.y };
          }
        if (best) hoverAnchor = best;
      }
      return;
    }
    // Once the pointer travels past CLICK_SLOP_PX (screen px) the gesture is a
    // DRAG, not a click — this latches the flag a pending shift-click reads on
    // release to decide toggle-vs-axis-lock (AnnotateBar:450 precedent). Only
    // gestures that recorded a down position participate.
    if (drag.downScreen && !drag.moved) {
      const s = screenPoint(e);
      if (Math.hypot(s.x - drag.downScreen.x, s.y - drag.downScreen.y) > CLICK_SLOP_PX) drag.moved = true;
    }
    if (drag.kind === "move") moveDrag(e, w);
    else if (drag.kind === "resize") resizeDrag(e, w);
    else if (drag.kind === "multiresize") multiResizeDrag(e, w);
    else if (drag.kind === "endpoint") endpointDrag(w);
    else if (drag.kind === "modifier") modifierDrag(w);
    else if (drag.kind === "band") bandDrag(w, e.shiftKey);
    else if (drag.kind === "place") placementDrag(e, w);
    // "shiftpick" = a deferred shift-click on a NON-draggable item: no drag
    // behavior, only the slop tracking above, so the pointer path does nothing.
  }

  // ── Rubber-band selection drag ─────────────────────────────────────────────

  /**
   * Command (updates band preview state). Recomputes the world-space band rect
   * and the live CANDIDATE set — the items the current box would catch in the
   * drag's mode (core/bandselect.js: INNER = fully enclosed by the box, OUTER =
   * touching counts; bounds = the conservative rotated world AABB). Candidates
   * render as preview outlines; the selection/deselection itself is applied on
   * pointer-up. `shiftHeld` (manifest Round 12B "SHIFT during a band drag =
   * DESELECT the caught items instead of select") is latched into drag.deselect
   * on to EVERY move — it re-reads live so toggling Shift mid-drag flips the
   * pending action, matching how the axis-lock/resize modifiers already
   * re-read their event flags each move rather than freezing at grab time.
   */
  function bandDrag(w, shiftHeld) {
    drag.lastWorld = w;
    drag.deselect = shiftHeld;
    bandRect = rectFromCorners(drag.startWorld, w);
    bandCandidates = selectInBox(app.nodes(), bandRect, drag.mode);
  }

  // ── Crosshair placement drag (manifest ARCHITECTURE PLAN #5 + ROUND 13.2
  // CREATION-DRAG MODIFIERS + CREATION ANCHOR SNAP) ──────────────────────────

  /**
   * Pure-ish (reads app scene state; geometry itself is deterministic). The
   * world-space point (wx, wy) snapped onto other nodes' features, via the
   * SAME solveSnap call moveDrag makes for a single dragged point — anchors
   * ARE point-kind snap features (nodeFeatures' 9 bbox points), so no separate
   * anchor pass exists; this is the one snap substrate. No self-exclusion is
   * needed (unlike moveDrag/resizeDrag, which drag an EXISTING item and must
   * exclude it from its own candidate features): a creation drag places a
   * brand-new item, so every OTHER node is a legitimate snap target. Returns
   * {x, y, guides} — guides empty when nothing snapped or app.snapEnabled is
   * off.
   */
  function snapPoint(wx, wy) {
    if (!app.snapEnabled) return { x: wx, y: wy, guides: [] };
    const features = app.nodes().flatMap(nodeFeatures);
    const tol = SNAP_PX / viewport.zoom;
    const s = solveSnap([{ kind: "point", x: wx, y: wy, id: "creation" }], features, tol);
    if (s.dx !== 0 || s.dy !== 0) app.snapEngaged = true;
    return { x: wx + s.dx, y: wy + s.dy, guides: s.guides };
  }

  /**
   * Command (updates placement preview state). Recomputes the world-space
   * preview a drag-placement is about to create, EVERY move, straight from
   * drag.startWorld + the raw pointer + the CURRENT modifier keys — never
   * from a rebased "last" box the way resizeDrag must (resize measures a
   * pointer DELTA off a mutable baseBox/basePointer that has to rebase when a
   * modifier toggles mid-drag, manifest "Drag/resize modifiers"; a creation
   * drag has no such mutable base — it is always start→pointer, so engaging
   * or releasing Shift/Cmd mid-drag is ALREADY live with zero jump, by
   * construction, satisfying 13.2's "modifiers must be LIVE" requirement with
   * no rebase bookkeeping to get wrong).
   *
   * Both the drag's start point and the live pointer point are snapped
   * (manifest 13.2: "both the start point and the live drag point") via the
   * SAME solveSnap the single-item move drag uses (snapPoint above) — the
   * START point was already snapped once at pointer-DOWN (onPointerDown
   * stores the snapped value straight into drag.startWorld, so a plain CLICK
   * placement — no move ever fires — still gets it; re-snapping the same
   * fixed point every move here would be redundant, not wrong, but the stored
   * value is the single source of truth). Only the LIVE pointer point is
   * snapped fresh on every move. For an ENDPOINT (arrow) placement the
   * snapped `from`/`to` are the widget's own final endpoints; for a BBOX
   * placement the snapped corners are fed into creationRect same as the raw
   * ones, so a modifier's aspect/center reading still applies to the SNAPPED
   * corners (matching resizeDrag's own modifier-bypasses-snap ordering is
   * unnecessary here — a creation rect has no fixed opposite edge to protect,
   * so snapping first and then reshaping around the (possibly snapped) two
   * corners is the correct order: the anchor point genuinely is either
   * corner, snapped or not).
   */
  function placementDrag(e, w) {
    drag.lastWorld = w;
    const mods = { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey };
    const start = drag.startWorld;
    const live = snapPoint(w.x, w.y);
    // The start point's guide (if it snapped at grab time) stays visible for
    // the WHOLE drag — its correction is fixed (drag.startGuides), only the
    // live point's guide is recomputed every move.
    guides = [...drag.startGuides, ...live.guides];
    if (drag.plugin.placement === "endpoints") {
      // Stashed for placementUp (manifest pattern: resizeDrag stashes
      // drag.lastBox the same way) — the commit reads exactly what was last
      // previewed rather than re-deriving from modifier keys that a plain
      // pointerup event doesn't carry.
      drag.lastEndpoint = creationEndpoint(start.x, start.y, live.x, live.y, mods);
      placeLine = { x1: drag.lastEndpoint.from.x, y1: drag.lastEndpoint.from.y, x2: drag.lastEndpoint.to.x, y2: drag.lastEndpoint.to.y };
    } else {
      const [x0, y0, x1, y1] = creationRect(start.x, start.y, live.x, live.y, mods);
      drag.lastRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      placeRect = drag.lastRect;
    }
  }

  /**
   * Command. Places the armed plugin's widget on release. TWO placement kinds,
   * chosen by the plugin's declared `placement` descriptor (manifest UNDEFERRAL
   * SWEEP: "crosshair PLACEMENT for ALL Add buttons"; the per-plugin descriptor
   * is the ONE piece of type knowledge — everything else here is generic):
   *
   *   BBOX (default — `placement` absent or "bbox"; rect/text/donut/magnifier/
   *   cropbox/image/video): a DRAG (moved past CLICK_SLOP_PX) places at the
   *   EXACT dragged rect; a plain CLICK places at the plugin's default size
   *   (`defaults.w`/`.h`), CENTERED on the click point (manifest Round 12B
   *   "Boxes": "a SINGLE CLICK places a default-size box... centered" — the
   *   same centering rule #insertMediaAt uses for dropped media). `?? 0` is a
   *   defensive fallback for a bbox default with no size (none exist today).
   *
   *   ENDPOINTS (`placement` === "endpoints"; the arrow family): a DRAG lays
   *   from→to along the dragged segment (from = start corner, to = release
   *   corner — the endpoints ARE the gesture, no bbox); a plain CLICK places a
   *   default-length arrow rightward from the point, the length taken from the
   *   plugin's own `defaults.to.x − defaults.from.x` (a LINKED precedent — the
   *   widget's own shipped default extent — not an invented constant).
   *
   * Both kinds route through app.addItem exactly like the plugin's OLD
   * immediate-spawn `run`, so identity/z/active:true keyframing is unchanged —
   * only the geometry now comes from the gesture instead of `defaults` verbatim.
   *
   * A DRAG (drag.moved) commits drag.lastRect/lastEndpoint — the SAME
   * modifier- and snap-corrected geometry placementDrag last previewed
   * (manifest 13.2: Shift/Cmd modifiers + anchor/feature snap on creation
   * drags), never a fresh rectFromCorners(startWorld, lastWorld) that would
   * silently discard both. A plain CLICK (never moved, so placementDrag never
   * ran) is unchanged: default size/length centered/rightward on the point —
   * modifiers and snap have no meaning for a single click with no drag vector.
   */
  function placementUp() {
    const { plugin, startWorld } = drag;
    if (plugin.placement === "endpoints") {
      if (drag.moved) {
        app.addItem({ ...plugin.defaults, from: drag.lastEndpoint.from, to: drag.lastEndpoint.to });
      } else {
        // Default length = the plugin's own shipped from→to extent (linked
        // precedent), placed rightward from the click point.
        const d = plugin.defaults;
        const len = (d.to?.x ?? 0) - (d.from?.x ?? 0);
        app.addItem({ ...d, from: { x: startWorld.x, y: startWorld.y }, to: { x: startWorld.x + len, y: startWorld.y } });
      }
    } else if (drag.moved) {
      const r = drag.lastRect;
      app.addItem({ ...plugin.defaults, x: r.x, y: r.y, w: r.w, h: r.h });
    } else {
      const w = plugin.defaults.w ?? 0, h = plugin.defaults.h ?? 0;
      app.addItem({ ...plugin.defaults, x: startWorld.x - w / 2, y: startWorld.y - h / 2 });
    }
    placeRect = null;
    placeLine = null;
  }

  function moveDrag(e, w) {
    let dx = w.x - drag.startWorld.x;
    let dy = w.y - drag.startWorld.y;
    const newGuides = [];
    // moveBy widgets (arrows) have no bbox/point features to probe, so they
    // get axis lock but no feature snapping.
    const custom = !!drag.plugin.moveBy;
    if (e.shiftKey) {
      // Axis lock with hysteresis; guide is an INFINITE line through the
      // item's CENTER at the drag origin (clipped to the viewport at render
      // time). The lock measures from the drag ORIGIN — engaging shift
      // mid-drag aligns to the axis through the start pose, which is the
      // point of axis-align (Figma/PPT semantics; editor_smoke encodes it).
      drag.axis = axisLock(dx, dy, drag.axis);
      if (drag.axis === "x") dy = 0;
      else dx = 0;
      const origin = drag.centerWorld ?? drag.startWorld;
      newGuides.push({
        kind: "line",
        x: origin.x, y: origin.y,
        dx: drag.axis === "x" ? 1 : 0, dy: drag.axis === "x" ? 0 : 1,
      });
    } else if (!custom) {
      drag.axis = null;
      // Snap: probe with the dragged item's own point features at the
      // proposed position; snap against every OTHER node's features.
      // Gated on app.snapEnabled (master toggle — off = no snapping anywhere).
      const nodes = app.nodes();
      const me = nodes.find((n) => n.itemId === drag.itemId);
      if (app.snapEnabled && me) {
        // The shifted world must be RE-DERIVED, never patched: for a rotated
        // item world.x ≠ state.x (the rotation pivot shifts the translation),
        // so overriding world.x with state.x+dx probed corners ~80px off the
        // true rotated geometry (Opus1 review finding #2).
        const shiftedState = { ...me.state, x: drag.startX + dx, y: drag.startY + dy };
        const shifted = { ...me, world: worldTransform(shiftedState), state: shiftedState };
        const probes = nodeFeatures(shifted).filter((f) => f.kind === "point");
        const features = snapCandidates(nodes).flatMap(nodeFeatures);
        const tol = SNAP_PX / viewport.zoom;
        const snap = solveSnap(probes, features, tol);
        dx += snap.dx;
        dy += snap.dy;
        newGuides.push(...snap.guides);
        // ANCHOR SNAP (manifest ARCHITECTURE PLAN #4): stash the CURRENT
        // move's provenance for onPointerUp to read if A is held at release
        // — cleared every move (a snap that stops applying mid-drag must not
        // leave a stale provenance an A-release would wrongly honor).
        drag.snapProvenance = (snap.dx !== 0 || snap.dy !== 0) ? snap.provenance : null;
        if (snap.dx !== 0 || snap.dy !== 0) app.snapEngaged = true;
      }
    } else {
      drag.axis = null;
    }
    guides = newGuides;
    // DRAG-ALL: the SAME (dx, dy) — already axis-locked and snapped on the
    // GRABBED item — translates EVERY member of the selection (manifest Round
    // 12). Each member follows its own rule: a moveBy widget (arrow) moves only
    // its free numeric coords (bound endpoints stay anchored); a bbox widget
    // writes plain numeric x/y. With one member (== the grabbed item) this is
    // byte-identical to the old single-item preview — the editor_smoke mid-drag
    // invariants keep holding.
    // Stashed for the anchor-snap release (writeMoveAnchorSnap): the FINAL
    // (post-axis-lock, post-snap) delta this move committed, so a rewrite at
    // release can rebuild the SAME DRAG-ALL pairs for every member and only
    // override the grabbed item's snapped coordinate(s) — never dropping the
    // other members' translation the way a bare re-setPreview([x,y]) would
    // (setPreview REPLACES previewDelta wholesale, it doesn't merge).
    drag.lastDx = dx;
    drag.lastDy = dy;
    const pairs = drag.members.flatMap((m) => translationPairs(m, dx, dy));
    if (pairs.length) app.setPreview(pairs);
  }

  // ── Resize ──────────────────────────────────────────────────────────────────
  // resizeAnchors / resizedBox are imported from ./canvas/dragKinds.js.

  function startResize(handleId, e) {
    // MULTI-RESIZE (manifest UNDEFERRAL SWEEP): a handle on a 2+ selection grabs
    // the collective AABB and scales every member about it — a different drag
    // kind from the single-item resize (which owns the rotation back-solve, edge
    // snapping, size-match indicators, anchor-snap). The overlay only shows
    // collective handles when >1 is selected, so this branch is never reached
    // for a single selection.
    if (app.selectedIds().length > 1) { startMultiResize(handleId, e); return; }
    const node = app.selectedNode();
    if (!node) return;
    e.stopPropagation();
    overlayEl.setPointerCapture(e.pointerId);
    const h = handleId;
    const grab = worldPoint(e);
    drag = {
      kind: "resize",
      itemId: node.itemId,
      handleId,
      // A GROUP resizes by driving its own SIMILARITY `scale` (which members
      // inherit through applyGroupParenting), never w/h — so it needs its start
      // scale. Members follow with zero writes (manifest 15.7 GROUP RESIZE).
      group: node.type === "group",
      startScale: node.state.scale ?? 1,
      startState: { x: node.state.x, y: node.state.y, w: node.state.w, h: node.state.h },
      world: node.world,
      // Which edges this handle moves — used by edge/size snapping. World-space
      // edge snapping only makes sense for an axis-aligned box, so we flag
      // rotation and skip snapping (not wrong math) for rotated items.
      west: h.includes("l"), east: h.includes("r"), north: h.includes("t"), south: h.includes("b"),
      rotated: Math.abs((node.state.rotation ?? 0) % (2 * Math.PI)) > 1e-9,
      // Modifier + rebase bookkeeping (manifest "Drag/resize modifiers").
      // baseBox/basePointer = box + pointer at the LAST modifier toggle, in
      // the ORIGINAL local frame ([0, 0, w, h] = the box at grab); resize is
      // pointer-DELTA-based from there, so toggling Shift/Cmd mid-drag
      // rebases instead of jumping (the Pixel-Aligner lesson), and grabbing
      // a handle slightly off-center no longer nudges the box.
      mods: { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey },
      baseBox: [0, 0, node.state.w, node.state.h],
      lastBox: [0, 0, node.state.w, node.state.h],
      basePointer: T.apply(T.invert(node.world), grab.x, grab.y),
    };
    hoverAnchor = null; // a hover tip must not linger frozen through the drag
    app.dragging = true;
    app.dragKind = "resize";
  }

  function resizeDrag(e, w) {
    const s = drag.startState;
    const local = T.apply(T.invert(drag.world), w.x, w.y); // pointer in the item's local space
    const mods = { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey };
    if (mods.uniform !== drag.mods.uniform || mods.symmetric !== drag.mods.symmetric) {
      // Modifier rebase: the new constraint measures from the CURRENT box and
      // pointer, so engaging/releasing Shift or Cmd mid-drag never jumps.
      drag.baseBox = drag.lastBox;
      drag.basePointer = local;
      drag.mods = mods;
    }
    // GROUP RESIZE (manifest 15.7): a group drives its own uniform `scale`
    // (members inherit it through applyGroupParenting) + x/y compensation to pin
    // the grabbed handle's opposite corner — NOT w/h. It is UNIFORM-only (the
    // similarity model has no per-axis group scale — it would shear members), so
    // Shift is already implied; Cmd still scales about the group center. Members
    // follow with ZERO per-member writes (pure/keyframable). Returns early — the
    // group has no rotated-pivot w/h path (groupResizeState handles rotation).
    if (drag.group) { groupResizeDrag(local, mods); return; }
    const edges = { west: drag.west, east: drag.east, north: drag.north, south: drag.south };
    const box = resizedBox(
      drag.baseBox,
      { x: local.x - drag.basePointer.x, y: local.y - drag.basePointer.y },
      edges, mods,
    );
    drag.lastBox = box;
    let ww = box[2] - box[0], hh = box[3] - box[1];
    // Local origin shift → state translation through the item's world
    // transform (rotation-aware — the same conversion the west/north handles
    // always used): state x/y move by the world delta of local (x0, y0).
    const o = T.apply(drag.world, 0, 0);
    const p = T.apply(drag.world, box[0], box[1]);
    let x = s.x + (p.x - o.x);
    let y = s.y + (p.y - o.y);

    // Snapping (edge→line + size-match) operates in WORLD space on the
    // axis-aligned case only. For rotated items the box edges aren't axis
    // parallel, so we skip snapping rather than produce wrong math. Active
    // MODIFIERS also bypass it: a per-edge snap correction would silently
    // break the invariant the modifier holds (aspect ratio / fixed center);
    // constraint-respecting snap is a separate design decision.
    let newGuides = [], indicators = [];
    // ANCHOR SNAP (manifest ARCHITECTURE PLAN #4): cleared every move (like
    // moveDrag's) so a snap that stops applying mid-drag can't leave a stale
    // provenance an A-release would wrongly honor. Set below only when the
    // gate (unrotated, enabled, no modifier) is open AND a correction lands.
    drag.snapProvenance = null;
    if (!drag.rotated && app.snapEnabled && !mods.uniform && !mods.symmetric) {
      const r = applyResizeSnap({ x, y, ww, hh });
      x = r.x; y = r.y; ww = r.ww; hh = r.hh;
      newGuides = r.guides;
      indicators = r.indicators;
      drag.snapProvenance = r.edgeProvenance;
      // Fold the snap correction back into lastBox (unrotated ⇒ world delta =
      // scale · local delta) so a modifier engaging on the NEXT move rebases
      // from exactly the box on screen.
      const k = drag.world.scale;
      drag.lastBox = [(x - s.x) / k, (y - s.y) / k, (x - s.x) / k + ww, (y - s.y) / k + hh];
    }
    if (mods.uniform) {
      // The uniform CORNER scale shows its DIAGONAL guideline (manifest): the
      // infinite line the grabbed corner rides — through the opposite corner,
      // or through the center (the full diagonal) when symmetric. Edge-handle
      // uniform has no diagonal to ride, so no guide.
      const a = resizeAnchors(drag.baseBox, edges, mods);
      if (a.xActive && a.yActive && (a.gx !== a.fx || a.gy !== a.fy)) {
        const fW = T.apply(drag.world, a.fx, a.fy);
        const gW = T.apply(drag.world, a.gx, a.gy);
        newGuides.push({ kind: "line", x: fW.x, y: fW.y, dx: gW.x - fW.x, dy: gW.y - fW.y });
      }
    }
    guides = newGuides;
    sizeIndicators = indicators;

    // ROTATED-RESIZE PIVOT PIN (registry #1, PPT opposite-handle). The box was
    // laid out in drag.world — the transform with the pivot FIXED where it was
    // at grab (drag.world never re-centers mid-drag). But the item keeps its
    // `self.anchors.center` rotationAnchor equation, so BOTH the live derivation
    // and the commit would otherwise re-center the pivot to the new box center
    // and shift the whole box (the "fixed" opposite edge drifted 10-40px,
    // registry-measured). Fix: back-solve x/y so the re-centered CENTER pivot
    // reproduces the SAME world the fixed pivot painted — the opposite edge then
    // stays put in world space and the grabbed edge tracks the cursor exactly,
    // while the stored pivot stays the clean center equation (nothing numeric is
    // persisted, so future rotations orbit the NEW center). Unrotated items are
    // untouched: their pivot is irrelevant (worldTransform short-circuits at
    // rotation 0) and edge snapping already handles them. Cmd-symmetric keeps
    // the center fixed, so the back-solve is a coincidental no-op there — the
    // modifier still works.
    if (drag.rotated) {
      const topLeftWorld = T.apply(drag.world, box[0], box[1]); // intended local(0,0) in world
      const pinnedWorld = { x: topLeftWorld.x, y: topLeftWorld.y, rotation: drag.world.rotation, scale: drag.world.scale };
      const solved = stateXYForCenterPivotWorld(pinnedWorld, ww, hh);
      x = solved.x;
      y = solved.y;
    }

    app.setPreview([
      [["items", drag.itemId, "x"], x],
      [["items", drag.itemId, "y"], y],
      [["items", drag.itemId, "w"], ww],
      [["items", drag.itemId, "h"], hh],
    ]);
  }

  /**
   * GROUP resize per-move (manifest 15.7). Maps the handle drag into the
   * group's own uniform `scale` + x/y (groupResizeState — pure, rotation-aware),
   * so every member scales+moves about the grabbed handle's FIXED opposite
   * corner through the EXISTING parenting composition, with zero per-member
   * writes. w/h are left untouched (the hull is scale·w, so `scale` grows it);
   * the whole gesture commits as ONE undo unit via the standard preview→
   * commitPreview path. The uniform diagonal guide (the line the grabbed corner
   * rides) is shown, matching single-item uniform resize.
   */
  function groupResizeDrag(local, mods) {
    const edges = { west: drag.west, east: drag.east, north: drag.north, south: drag.south };
    const dLocal = { x: local.x - drag.basePointer.x, y: local.y - drag.basePointer.y };
    // Track lastBox so a modifier rebase (Cmd toggle) measures from the box on
    // screen — same bookkeeping the single-item path keeps (uniform forced).
    drag.lastBox = resizedBox(drag.baseBox, dLocal, edges, { ...mods, uniform: true });
    const gs = groupResizeState(
      { x: drag.startState.x, y: drag.startState.y, w: drag.startState.w, h: drag.startState.h, rotation: drag.world.rotation, scale: drag.startScale },
      drag.world, edges, mods, dLocal,
    );
    // Uniform diagonal guide: the infinite line the grabbed corner rides through
    // the fixed anchor (or the center when Cmd-symmetric) — corner grabs only.
    const a = resizeAnchors(drag.baseBox, edges, { ...mods, uniform: true });
    guides = (a.xActive && a.yActive && (a.gx !== a.fx || a.gy !== a.fy))
      ? [(() => { const fW = T.apply(drag.world, a.fx, a.fy), gW = T.apply(drag.world, a.gx, a.gy); return { kind: "line", x: fW.x, y: fW.y, dx: gW.x - fW.x, dy: gW.y - fW.y }; })()]
      : [];
    sizeIndicators = [];
    app.setPreview([
      [["items", drag.itemId, "scale"], gs.scale],
      [["items", drag.itemId, "x"], gs.x],
      [["items", drag.itemId, "y"], gs.y],
    ]);
  }

  // ── Multi-resize (manifest UNDEFERRAL SWEEP: handles on a multi-selection ────
  // scale ALL members about the collective AABB, PPT semantics). The collective
  // box is AXIS-ALIGNED in world space, so it reuses the SAME resizedBox/
  // resizeAnchors modifier machinery as the single-item resize; the difference
  // is only WHAT gets scaled: instead of one item's local box, every member's
  // world position AND size scale about the box's fixed anchor (scaleMemberPairs
  // — the exact rotation-aware scale, shared with the S-modal). Cmd-symmetric
  // and Shift-uniform work on the collective box for free (they're resizedBox's
  // own modifier params). Snap runs on the collective box edges.

  function startMultiResize(handleId, e) {
    const members = translateMembers(app.nodes());
    const box0 = selectionAABB(app.selectedNodes());
    if (!box0 || members.length === 0) return; // nothing bounded to resize
    e.stopPropagation();
    overlayEl.setPointerCapture(e.pointerId);
    const h = handleId;
    const grab = worldPoint(e);
    const base = [box0.x, box0.y, box0.x + box0.w, box0.y + box0.h]; // world AABB [x0,y0,x1,y1]
    drag = {
      kind: "multiresize",
      handleId,
      members,
      west: h.includes("l"), east: h.includes("r"), north: h.includes("t"), south: h.includes("b"),
      // Same modifier + rebase bookkeeping as the single resize, but the
      // "local" frame IS world (the collective box is world-axis-aligned), so
      // basePointer is the grab point in world and the delta is a plain world
      // delta — no per-item transform inversion.
      mods: { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey },
      baseBox: base,
      lastBox: base,
      basePointer: { x: grab.x, y: grab.y },
    };
    hoverAnchor = null;
    app.dragging = true;
    app.dragKind = "multiresize";
  }

  function multiResizeDrag(e, w) {
    const mods = { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey };
    if (mods.uniform !== drag.mods.uniform || mods.symmetric !== drag.mods.symmetric) {
      drag.baseBox = drag.lastBox; // rebase from the box on screen (no jump on toggle)
      drag.basePointer = { x: w.x, y: w.y };
      drag.mods = mods;
    }
    const edges = { west: drag.west, east: drag.east, north: drag.north, south: drag.south };
    let box = resizedBox(drag.baseBox, { x: w.x - drag.basePointer.x, y: w.y - drag.basePointer.y }, edges, mods);

    // Snap the collective box edges to other nodes' features (same edge→line
    // solver the single resize uses), unless a modifier is active (a per-edge
    // correction would break the modifier's aspect/center invariant).
    let newGuides = [];
    if (app.snapEnabled && !mods.uniform && !mods.symmetric) {
      const snapped = snapMultiBox(box, edges);
      box = snapped.box;
      newGuides = snapped.guides;
    }
    guides = newGuides;
    sizeIndicators = [];

    // Map the OLD collective box → the NEW one as a per-axis scale about the
    // fixed anchor (resizeAnchors gives the fixed point / center), then scale
    // every member about it. Degenerate old extent (a zero-width selection) →
    // factor 1 on that axis (no scale, avoids /0).
    const b0 = drag.baseBox;
    const oldW = b0[2] - b0[0], oldH = b0[3] - b0[1];
    const kx = oldW > 1e-9 ? (box[2] - box[0]) / oldW : 1;
    const ky = oldH > 1e-9 ? (box[3] - box[1]) / oldH : 1;
    const a = resizeAnchors(b0, edges, mods);
    const ax = mods.symmetric ? a.cx : a.fx;
    const ay = mods.symmetric ? a.cy : a.fy;
    const pairs = drag.members.flatMap((m) => scaleMemberPairs(m, kx, ky, ax, ay));
    if (pairs.length) app.setPreview(pairs);
  }

  /**
   * Snaps the collective multi-resize box's MOVING edges to other nodes' line
   * features (the same solveEdgeSnap the single-item resize uses), returning the
   * corrected box and the aligned guides. World-space and axis-aligned, so no
   * per-item scale factor is involved (the collective box IS in world units).
   * Near-pure: reads app scene state + raises app.snapEngaged when a correction
   * lands; geometry itself is deterministic.
   */
  function snapMultiBox(box, edges) {
    const tol = SNAP_PX / viewport.zoom;
    const nodes = app.nodes();
    // Exclude every selected id AND (for any selected group) its members — they
    // move with the collective box, so their features are self-references
    // (manifest 15.7 SNAP EXCLUSION, extended to the multi-resize collective box).
    const membership = groupMembership(nodes);
    const ids = new Set();
    for (const sid of app.selectedIds())
      for (const ex of snapExclusionSet(sid, membership, nodes)) ids.add(ex);
    const others = nodes.filter((n) => !ids.has(n.itemId));
    const probes = [];
    if (edges.east) probes.push({ axis: "x", pos: box[2] });
    if (edges.west) probes.push({ axis: "x", pos: box[0] });
    if (edges.south) probes.push({ axis: "y", pos: box[3] });
    if (edges.north) probes.push({ axis: "y", pos: box[1] });
    const features = others.flatMap(nodeFeatures);
    const es = solveEdgeSnap(probes, features, tol);
    const out = [...box];
    if (edges.east) out[2] += es.dx;
    if (edges.west) out[0] += es.dx;
    if (edges.south) out[3] += es.dy;
    if (edges.north) out[1] += es.dy;
    if (es.dx !== 0 || es.dy !== 0) app.snapEngaged = true;
    return { box: out, guides: es.guides };
  }

  /**
   * Snaps an in-progress axis-aligned resize. Returns corrected {x,y,ww,hh},
   * the aligned line `guides`, matching-dimension `indicators`, and
   * `edgeProvenance` (manifest ARCHITECTURE PLAN #4 — the EDGE→LINE snap's
   * source only, never the size-match step: "v1 scope: move point/edge snaps
   * + resize edge snaps; skip size-match snaps"). The moving edges snap to
   * other nodes' infinite lines (solveEdgeSnap); when the master item's
   * width/height lands within tolerance of another VISIBLE bbox item's same
   * dimension it snaps EXACTLY to it (sizeMatches, gated on snapSizeEnabled)
   * and every matching object gets a two-way-arrow indicator across its span.
   * Raises app.snapEngaged whenever any correction is applied.
   *
   * Near-pure (mutates app.snapEngaged and reads app scene state); geometry
   * itself is world-space and deterministic.
   */
  function applyResizeSnap({ x, y, ww, hh }) {
    const scale = drag.world.scale;
    const tol = SNAP_PX / viewport.zoom;
    const others = snapCandidates(app.nodes());
    const guides = [], indicators = [];
    let engaged = false;

    // ── Edge → line snapping (right/left in x, bottom/top in y) ──
    const edges = [];
    if (drag.east) edges.push({ axis: "x", pos: x + scale * ww });
    if (drag.west) edges.push({ axis: "x", pos: x });
    if (drag.south) edges.push({ axis: "y", pos: y + scale * hh });
    if (drag.north) edges.push({ axis: "y", pos: y });
    const features = others.flatMap(nodeFeatures);
    const es = solveEdgeSnap(edges, features, tol);
    // A moving right/bottom edge changes size; a moving left/top edge changes
    // both origin and size (opposite edge stays put).
    if (drag.east) ww += es.dx / scale;
    if (drag.west) { x += es.dx; ww -= es.dx / scale; }
    if (drag.south) hh += es.dy / scale;
    if (drag.north) { y += es.dy; hh -= es.dy / scale; }
    if (es.dx !== 0 || es.dy !== 0) engaged = true;
    guides.push(...es.guides);
    const edgeProvenance = (es.dx !== 0 || es.dy !== 0) ? es.provenance : null;

    // ── Size matching (Figma-style matching-dimension indicator) ──
    if (app.snapSizeEnabled) {
      const bbox = others.filter((n) => n.plugin.capabilities.bbox);
      // Width match when a horizontal edge (E/W) is moving; height when N/S.
      if (drag.east || drag.west) {
        const m = sizeMatches(ww * scale, bbox.map((n) => ({ id: n.itemId, size: (n.state.w ?? 0) * n.world.scale })), tol);
        if (m) {
          const target = m.value / scale; // exact width in the master's local units
          if (drag.west) x += scale * (ww - target); // keep the fixed (right) edge put
          ww = target;
          engaged = true;
          for (const id of m.ids) indicators.push({ axis: "w", ...worldAABB(others.find((n) => n.itemId === id)) });
          indicators.push({ axis: "w", x, y, w: scale * ww, h: scale * hh });
        }
      }
      if (drag.north || drag.south) {
        const m = sizeMatches(hh * scale, bbox.map((n) => ({ id: n.itemId, size: (n.state.h ?? 0) * n.world.scale })), tol);
        if (m) {
          const target = m.value / scale;
          if (drag.north) y += scale * (hh - target); // keep the fixed (bottom) edge put
          hh = target;
          engaged = true;
          for (const id of m.ids) indicators.push({ axis: "h", ...worldAABB(others.find((n) => n.itemId === id)) });
          indicators.push({ axis: "h", x, y, w: scale * ww, h: scale * hh });
        }
      }
    }
    if (engaged) app.snapEngaged = true;
    return { x, y, ww, hh, guides, indicators, edgeProvenance };
  }

  /** Pure-ish. The world-space axis-aligned bbox {x,y,w,h} of a bbox node. */
  function worldAABB(node) {
    return {
      x: node.world.x,
      y: node.world.y,
      w: (node.state.w ?? 0) * node.world.scale,
      h: (node.state.h ?? 0) * node.world.scale,
    };
  }

  // ── Arrow endpoint drag (anchor binding UX) ────────────────────────────────

  function startEndpoint(which, e) {
    const node = app.selectedNode();
    if (!node) return;
    e.stopPropagation();
    overlayEl.setPointerCapture(e.pointerId);
    // The anchors TOGGLE alone decides glyph visibility and binding — an
    // endpoint drag never touches it ("toggle anchors means toggle anchors
    // PERIOD", manifest Anchor UX). Live bind feedback flows through
    // hoverAnchor + dynamicAnchor, set per-move in endpointDrag.
    hoverAnchor = null; // pre-drag hover tip must not linger stale
    drag = { kind: "endpoint", itemId: node.itemId, which };
    app.dragging = true;
  }

  function endpointDrag(w) {
    const tol = SNAP_PX / viewport.zoom;
    // Anchor binding is GATED on the anchors toggle, and only ever happens
    // within the ONE uniform snap threshold — dragging past it DETACHES the
    // endpoint back to plain numbers (user rule; the old drop-anywhere-on-body
    // "closest" rebinding was sticky and obnoxious).
    // THE UNIFICATION: binding WRITES EQUATIONS — dropping on an anchor sets
    // from/to x/y to "@<itemId>_<anchorId>.x"/".y" (anchors are variables).
    let xy = { x: w.x, y: w.y };
    // Live bind feedback (manifest Anchor UX): every move re-decides the
    // candidate; the tooltip names EXACTLY what a drop right now would bind
    // (or clears when the drop would write plain numbers).
    hoverAnchor = null;
    dynamicAnchor = null;
    if (app.anchorsVisible) {
      // Anchors ARE point-kind features, so the SAME group exclusion applies
      // (manifest 15.7): an arrow endpoint that belongs to a group won't bind to
      // its own group's anchors, and a grouped target's members are excluded.
      const nodes = snapCandidates(app.nodes());
      let best = null;
      for (const n of nodes)
        for (const a of nodeAnchors(n)) {
          const d = Math.hypot(a.x - w.x, a.y - w.y);
          if (d <= tol && (!best || d < best.d)) best = { d, itemId: n.itemId, anchorId: a.id, x: a.x, y: a.y };
        }
      if (best) {
        xy = { x: `@${best.itemId}_${best.anchorId}.x`, y: `@${best.itemId}_${best.anchorId}.y` };
        hoverAnchor = { label: app.anchorName(best.itemId, best.anchorId), x: best.x, y: best.y };
      } else {
        // "closest" computed anchor binds only when the pointer is within the
        // SAME threshold of the perimeter point it would produce.
        const hit = pickNode(nodes, w.x, w.y);
        if (hit?.plugin.closestAnchor) {
          const local = hit.plugin.closestAnchor(hit.state, w.x, w.y, hit.world);
          const p = T.apply(hit.world, local.x, local.y);
          if (Math.hypot(p.x - w.x, p.y - w.y) <= tol) {
            xy = { x: `@${hit.itemId}_closest.x`, y: `@${hit.itemId}_closest.y` };
            // A DYNAMIC anchor (a live function of the drag, not a preset
            // point): named like any anchor, marked with the # glyph.
            hoverAnchor = { label: app.anchorName(hit.itemId, "closest"), x: p.x, y: p.y };
            dynamicAnchor = { x: p.x, y: p.y };
          }
        }
      }
    }
    app.setPreview([
      [["items", drag.itemId, drag.which, "x"], xy.x],
      [["items", drag.itemId, drag.which, "y"], xy.y],
    ]);
  }

  // ── Modifier point drag (manifest ARCHITECTURE PLAN #1) ───────────────────
  // A modifier point is a highly-constrained handle that writes ONE widget
  // parameter along a restricted trajectory (donut's inner-radius proportion
  // is the first consumer). The drag kind mirrors "endpoint" (a single-point
  // grab captured on the overlay) but routes through the plugin's own
  // apply(state, localPoint) instead of writing x/y directly — CanvasView
  // never reasons about WHAT the point controls, only WHERE it is and how to
  // invert a world-space drag back to local before handing it to the plugin.
  // Rotation/scale are correct BY CONSTRUCTION: nodeModifierPoints already
  // wrapped the point through node.world for display and hit-testing, and
  // here the drag point is inverted back through the SAME node.world before
  // apply() ever sees it — apply operates entirely in the item's own local
  // frame, exactly as if it were unrotated.

  function startModifier(id, e) {
    const node = app.selectedNode();
    if (!node) return;
    e.stopPropagation();
    overlayEl.setPointerCapture(e.pointerId);
    hoverAnchor = null; // pre-drag hover tip must not linger stale
    drag = { kind: "modifier", itemId: node.itemId, modifierId: id, world: node.world };
    app.dragging = true;
    app.dragKind = "modifier";
  }

  function modifierDrag(w) {
    const node = app.nodes().find((n) => n.itemId === drag.itemId);
    if (!node) return; // item vanished mid-drag (e.g. purged elsewhere) — nothing to preview
    const mp = nodeModifierPoints(node).find((m) => m.id === drag.modifierId);
    if (!mp?.apply) return;
    const local = T.apply(T.invert(drag.world), w.x, w.y);
    const pairs = Object.entries(mp.apply(node.state, local))
      .map(([key, value]) => [["items", drag.itemId, key], value]);
    if (pairs.length) app.setPreview(pairs);
  }

  // ── Anchor snap release (manifest ARCHITECTURE PLAN #4) ────────────────────
  // Holding A through a move/resize release rewrites the snapped axes as
  // EQUATIONS referencing the provenance anchor instead of committing plain
  // numbers — a live binding, not a one-time correction. v1 scope: move
  // point/edge snaps + resize edge snaps (skip size-match snaps, per spec).

  /**
   * Query. The world-space coordinate of item `itemId`'s preset anchor
   * `anchorId` on `coord` ("x"|"y"), read from the CURRENT (post-drag,
   * pre-commit) node set — the same live state the equation will be
   * evaluated relative to at commit time, so the offset anchorSnapEquation
   * computes is exact. Returns null if the item or anchor is gone (e.g.
   * purged mid-drag by another gesture — defensive, not expected in
   * practice) so the caller can fall back to a plain numeric commit.
   */
  function anchorWorldCoord(itemId, anchorId, coord) {
    const node = app.nodes().find((n) => n.itemId === itemId);
    if (!node) return null;
    const a = nodeAnchors(node).find((x) => x.id === anchorId);
    return a ? a[coord] : null;
  }

  /**
   * Command. Rewrites drag.itemId's x/y as anchor-snap EQUATIONS for a MOVE
   * release (manifest: "move point/edge snaps"). `drag.snapProvenance` is
   * either ONE "both"-axis entry (a point snap — pins x AND y to the SAME
   * source point) or up to two single-axis entries (line snaps, one winner
   * per axis). Each axis whose provenance maps to a real preset anchor
   * (provenanceAnchorId) gets rewritten; an axis with no provenance, or whose
   * source anchor doesn't resolve, is left as whatever moveDrag already
   * wrote (a plain number) — no partial failure, just a partial equation.
   *
   * REBUILDS the full DRAG-ALL pairs set (drag.members × translationPairs,
   * the SAME call moveDrag's last move made) rather than writing just the
   * grabbed item's x/y — setPreview REPLACES previewDelta wholesale, so a
   * narrower call would silently drop every OTHER selected member's
   * translation on a multi-selection move. The grabbed item's pairs are
   * then overridden coordinate-by-coordinate with the equation string.
   */
  function writeMoveAnchorSnap() {
    const prov = drag.snapProvenance;
    if (!prov?.length) return;
    const pairs = drag.members.flatMap((m) => translationPairs(m, drag.lastDx, drag.lastDy));
    const overrides = new Map(); // "x"|"y" → equation string, for drag.itemId only
    for (const p of prov) {
      const anchorId = provenanceAnchorId(p.sourceAnchorId);
      if (!anchorId) continue; // non-standard source feature — no anchor to bind; numeric stands
      for (const coord of p.axis === "both" ? ["x", "y"] : [p.axis]) {
        const grabbed = pairs.find(([path]) => path[1] === drag.itemId && path[2] === coord);
        if (!grabbed || typeof grabbed[1] !== "number") continue; // moveBy widget (no plain x/y pair) — nothing to rewrite
        const anchorValue = anchorWorldCoord(p.sourceItemId, anchorId, coord);
        if (anchorValue == null) continue;
        overrides.set(coord, anchorSnapEquation(p.sourceItemId, anchorId, coord, grabbed[1], anchorValue));
      }
    }
    if (!overrides.size) return;
    const rewritten = pairs.map(([path, value]) =>
      path[1] === drag.itemId && overrides.has(path[2]) ? [path, overrides.get(path[2])] : [path, value]);
    app.setPreview(rewritten);
  }

  /**
   * Command. Rewrites drag.itemId's `w`/`h` as a "stretching" anchor-snap
   * EQUATION for a RESIZE release (manifest: "resize edge snaps... the
   * snapped edge writes the stretching equation — edge tracks the target").
   * Only the axis (x→w, y→h) whose provenance came from `applyResizeSnap`'s
   * EDGE step is rewritten (drag.snapProvenance already excludes size-match,
   * per its own doc) — `resizeEdgeEquation` needs the FIXED opposite edge's
   * world coordinate (a plain snapshot number, read from the CURRENT
   * committed geometry before this rewrite touches it) and the moving edge's
   * sign (east/south = +1, west/north = −1, drag.east/west/north/south).
   *
   * REBUILDS all four x/y/w/h keys from the current preview (resizeDrag's
   * last setPreview already wrote all four every move) rather than writing
   * just the snapped size — setPreview REPLACES previewDelta wholesale, so a
   * narrower call would silently drop the other three.
   */
  function writeResizeAnchorSnap() {
    const prov = drag.snapProvenance;
    if (!prov?.length) return;
    const node = app.nodes().find((n) => n.itemId === drag.itemId);
    if (!node) return;
    const scale = node.world.scale;
    const current = app.previewDelta?.items?.[drag.itemId] ?? {};
    const overrides = new Map(); // "w"|"h" → equation string
    for (const p of prov) {
      const anchorId = provenanceAnchorId(p.sourceAnchorId);
      if (!anchorId) continue;
      const coord = p.axis; // resize edge provenance is always single-axis (x or y — never "both")
      const sizeKey = coord === "x" ? "w" : "h";
      const movingEdge = coord === "x" ? (drag.east ? 1 : drag.west ? -1 : 0) : (drag.south ? 1 : drag.north ? -1 : 0);
      if (movingEdge === 0) continue; // this axis wasn't actually resized (shouldn't happen — defensive)
      // The FIXED opposite edge's current world coordinate: for an east/south
      // (sign +1) moving edge that's the node's own origin (world.x/.y —
      // never rewritten here); for a west/north (sign -1) moving edge it's
      // the far corner, read from the node's world bbox before this rewrite.
      const worldFixed = movingEdge > 0
        ? (coord === "x" ? node.world.x : node.world.y)
        : (coord === "x" ? node.world.x + scale * (node.state.w ?? 0) : node.world.y + scale * (node.state.h ?? 0));
      const anchorValue = anchorWorldCoord(p.sourceItemId, anchorId, coord);
      if (anchorValue == null) continue;
      overrides.set(sizeKey, resizeEdgeEquation(p.sourceItemId, anchorId, coord, movingEdge, worldFixed, scale));
    }
    if (!overrides.size) return;
    const pairs = ["x", "y", "w", "h"]
      .filter((k) => k in current)
      .map((k) => [["items", drag.itemId, k], overrides.get(k) ?? current[k]]);
    app.setPreview(pairs);
  }

  /** Command. Esc-cancels an in-progress modifier-point drag (manifest: "Esc
   * cancels"): drops the preview (reverting to the committed pose, exactly
   * like modal cancelPreview) and releases drag bookkeeping. A no-op unless a
   * modifier drag is actually live — called by the capture-phase keydown
   * listener below (this task's fence keeps the Escape wiring self-contained
   * in CanvasView rather than App.svelte's shortcut registry); guarding on
   * dragKind === "modifier" means it never touches a move/resize/endpoint/
   * band drag (those have no Esc-cancel yet — out of this task's fence). */
  function cancelModifierDrag() {
    if (drag?.kind !== "modifier") return;
    drag = null;
    hoverAnchor = null;
    app.dragging = false;
    app.dragKind = null;
    app.cancelPreview();
  }

  function onPointerLeave() {
    if (!drag && !modal) screenMouse = null; // hide ruler markers on leave (not mid-gesture)
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.kind === "band") {
      // Apply the band: recomputed from the drag's own endpoints (not the
      // render preview) so the result is deterministic. Caught = the items in
      // the final box (INNER/OUTER per drag.mode). Plain drag SELECTS them
      // (selectMany — empty result deselects); a SHIFT-held drag (manifest
      // Round 12B "SHIFT during a band drag = DESELECT the caught items
      // instead of select") removes them from whatever was already selected
      // instead — an empty catch is then a no-op, not a deselect-all.
      const caught = selectInBox(app.nodes(), rectFromCorners(drag.startWorld, drag.lastWorld), drag.mode);
      if (drag.deselect) {
        const remove = new Set(caught);
        app.selectMany(app.selectedIds().filter((id) => !remove.has(id)));
      } else {
        app.selectMany(caught);
      }
      bandRect = null;
      bandCandidates = [];
    } else if (drag.kind === "place") {
      placementUp();
    } else if (aHeld && drag.kind === "move") {
      // ANCHOR SNAP (manifest ARCHITECTURE PLAN #4): A held at release
      // rewrites the snapped axes as equations instead of the plain numbers
      // moveDrag already wrote — a no-op when nothing was snapping (no
      // provenance), so a plain A-held-but-not-snapped release commits
      // exactly like a plain release always has.
      writeMoveAnchorSnap();
    } else if (aHeld && drag.kind === "resize") {
      writeResizeAnchorSnap();
    }
    // Deferred shift-click: a shift+down released WITHIN the click slop (no drag)
    // toggles the hit item's selection membership (PPT/Figma add/remove). A
    // shift-DRAG (moved past the slop) leaves selection alone — it was an
    // axis-locked move, already committed via commitPreview below. `toggleId` is
    // set on both the "move" (draggable) and "shiftpick" (non-draggable) records.
    if (drag.toggleId && !drag.moved) app.toggleInSelection(drag.toggleId);
    drag = null;
    guides = [];
    sizeIndicators = [];
    hoverAnchor = null; // drag-time bind feedback ends with the gesture
    dynamicAnchor = null;
    app.snapEngaged = false; // cleared on pointer-up (per snap-round-2 spec)
    app.dragging = false;
    app.dragKind = null;
    app.commitPreview();
  }

  // ── Blender-style modal transforms (G grab / S scale) ──────────────────────

  /**
   * The collective world-space CENTER of a selection — the pivot the S modal
   * scales about (manifest Round 12: "about the SELECTION'S COLLECTIVE
   * CENTER"). It is the center of the AABB enclosing every selected node's
   * geometry: bbox nodes contribute their four world corners; endpoint widgets
   * (arrows) contribute their editable points (so a selected arrow counts).
   * Returns {x, y}, or null if nothing bounded was found.
   */
  /**
   * The collective world-space AABB of `nodes` (the same geometry
   * selectionCenter measures, factored out): bbox nodes contribute their four
   * world corners; endpoint widgets (arrows) contribute their editable points.
   * Returns {x, y, w, h} (world), or null if nothing bounded was found. This is
   * the box multi-RESIZE (manifest UNDEFERRAL SWEEP) grabs handles on.
   */
  function selectionAABB(nodes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const eat = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const n of nodes) {
      if (n.plugin.capabilities.bbox) {
        const w = n.state.w ?? 0, h = n.state.h ?? 0;
        for (const [lx, ly] of [[0, 0], [w, 0], [w, h], [0, h]]) {
          const p = T.apply(n.world, lx, ly);
          eat(p.x, p.y);
        }
      } else if (n.plugin.editPoints) {
        for (const ep of n.plugin.editPoints(n, byId)) eat(ep.x, ep.y);
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function selectionCenter(nodes) {
    const b = selectionAABB(nodes);
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  }

  /**
   * Command. Starts a modal transform: captures the cursor start point, the
   * translatable members (with start poses), and the collective center. Called
   * by the effect below when app.modalXform is set (the G/S shortcut). If the
   * cursor is off-canvas the start point falls back to the center, so a grab
   * begins at zero delta and a scale at factor 1.
   */
  function beginModal(kind) {
    const nodes = app.nodes();
    const center = selectionCenter(app.selectedNodes());
    const members = translateMembers(nodes);
    if (!center || members.length === 0) { app.modalXform = null; return; } // nothing to transform
    const start = mouseWorld ?? center;
    modal = { kind, startWorld: start, members, center, axis: null, buffer: "" };
    modalCenter = kind === "scale" ? center : null;
    // Paint the initial (zero-delta) preview immediately so the selection is
    // visibly "grabbed"/"scaling" before the first mouse move.
    modalMove(start);
  }

  /** Command. Records the cursor world point and re-derives the modal preview
   * from it. A NON-EMPTY numeric buffer means typed input wins (Blender modal
   * semantics): the pointer is remembered for a later clear but does NOT drive
   * the transform until the buffer is edited away. */
  function modalMove(w) {
    modal.lastWorld = w;
    if (modal.buffer !== "") return; // typed value drives; ignore pointer
    applyModal();
  }

  /** Command. Sets or toggles the axis constraint (Blender X/Y): the same axis
   * again clears it, the other axis switches. Re-derives the preview + axis
   * guide and mirrors the state to the HintBar. */
  function modalSetAxis(axis) {
    modal.axis = modal.axis === axis ? null : axis;
    syncModalXform();
    applyModal();
  }

  /** Command. Appends one character to the numeric buffer. Digits always append;
   * "." appends only if the buffer has no decimal yet; "-" appends only as the
   * first character (leading sign). For GRAB, digits require an axis constraint
   * first (the G-numeric-requires-axis ruling — see report); with no axis the
   * keystroke is a no-op and the HintBar keeps prompting for one. */
  function modalAppendBuffer(ch) {
    if (modal.kind === "grab" && !modal.axis) return; // pick an axis first (ruling)
    if (ch === "." && modal.buffer.includes(".")) return;
    if (ch === "-" && modal.buffer !== "") return;
    modal.buffer += ch;
    syncModalXform();
    applyModal();
  }

  /** Command. Deletes the last buffer character. Emptying the buffer hands the
   * transform back to the pointer (re-applies from the remembered cursor). */
  function modalBackspace() {
    if (modal.buffer === "") return;
    modal.buffer = modal.buffer.slice(0, -1);
    syncModalXform();
    applyModal();
  }

  /** Near-pure command (advances Svelte reactive state). Mirrors the modal's
   * live {kind, axis, buffer} into the reactive app.modalXform so the HintBar
   * announcement (mode · axis · buffer) re-derives. Reassigns the whole object
   * so the $derived tracking it invalidates. */
  function syncModalXform() {
    app.modalXform = { kind: modal.kind, axis: modal.axis, buffer: modal.buffer };
  }

  /**
   * Command. Re-derives the modal preview and the axis guide from the current
   * modal state (axis, buffer, lastWorld). GRAB translates by a world (dx, dy);
   * SCALE grows by a factor about the collective center. A non-empty numeric
   * buffer supplies the value EXACTLY (G X 2 = +2 world units; S 2 = factor 2;
   * S X 2 = width ×2 about the center); otherwise the pointer supplies it. The
   * axis constraint (if any) draws the infinite guide line through the center
   * using the SAME {kind:"line"} guide primitive as shift-axis-lock.
   */
  function applyModal() {
    const c = modal.center;
    const num = modal.buffer === "" ? null : Number(modal.buffer);
    // A partial buffer ("-", ".", "-.") is not yet a number — hold at identity.
    const typed = num !== null && Number.isFinite(num);

    if (modal.kind === "grab") {
      let dx, dy;
      if (typed) {
        // Numeric grab REQUIRES an axis (ruling); the value is the signed
        // distance along it. Guarded in modalAppendBuffer, so axis is set here.
        dx = modal.axis === "x" ? num : 0;
        dy = modal.axis === "y" ? num : 0;
      } else {
        const w = modal.lastWorld ?? modal.startWorld;
        dx = w.x - modal.startWorld.x;
        dy = w.y - modal.startWorld.y;
        if (modal.axis === "x") dy = 0;
        else if (modal.axis === "y") dx = 0;
      }
      const pairs = modal.members.flatMap((m) => translationPairs(m, dx, dy));
      if (pairs.length) app.setPreview(pairs);
    } else {
      // SCALE: factor = typed buffer, else current/initial cursor distance from
      // the collective center (Blender precedent). Degenerate start distance
      // (cursor began at the center) → factor 1 until it moves away.
      let factor;
      if (typed) factor = num;
      else {
        const w = modal.lastWorld ?? modal.startWorld;
        const d0 = Math.hypot(modal.startWorld.x - c.x, modal.startWorld.y - c.y);
        const d1 = Math.hypot(w.x - c.x, w.y - c.y);
        factor = d0 > 1e-9 ? d1 / d0 : 1;
      }
      app.setPreview(modal.members.flatMap((m) => scalePairs(m, factor, c, modal.axis)));
    }

    // Axis guide: an infinite line through the collective center along the
    // constrained axis — the SAME guide primitive shift-axis-lock uses (clipped
    // to the viewport at overlay time via clipLineToRect). Cleared with no axis.
    guides = modal.axis
      ? [{ kind: "line", x: c.x, y: c.y, dx: modal.axis === "x" ? 1 : 0, dy: modal.axis === "x" ? 0 : 1 }]
      : [];
  }

  // scaledBoxAboutPoint / scaleMemberPairs / scalePairs — the exact
  // rotation-aware scale-about-a-point math — are imported from
  // ./canvas/dragKinds.js (the extracted pure drag geometry). scalePairs is the
  // G/S-modal adapter; scaleMemberPairs the per-axis (multi-resize) form.

  /** Command. Confirms the modal transform: commit the preview as ONE undo unit
   * (the existing commitPreview) and leave the modal. Nulling app.modalXform
   * BEFORE committing means the tear-down effect sees `modal` already cleared
   * and does nothing (no double preview-drop). */
  function commitModal() {
    modal = null;
    modalCenter = null;
    guides = []; // drop the axis guide
    app.modalXform = null;
    app.commitPreview(); // one undo unit (or a no-op if the preview is empty)
  }

  /** Command. Cancels the modal transform: drop the preview (reverts the
   * selection to its committed pose) and leave the modal. */
  function cancelModal() {
    modal = null;
    modalCenter = null;
    guides = []; // drop the axis guide
    app.modalXform = null;
    app.cancelPreview();
  }

  // Start/tear-down the modal record when app.modalXform (set by the G/S
  // shortcut) flips. The shortcut lives in the registry (App.svelte); this
  // effect is the CanvasView side that owns the geometry + preview. Starting is
  // driven here; commit/cancel null the flag themselves (with `modal` already
  // cleared) so this branch only fires for an EXTERNAL clear (e.g. a mode
  // switch), which reverts safely. The effect ONLY reacts to modal presence
  // (x != null), not to axis/buffer edits inside it — those reassign
  // app.modalXform for the HintBar but must NOT retrigger begin/teardown; a
  // guard on `!modal`/`modal` already ensures that (an axis edit leaves both
  // truthy → neither branch runs).
  $effect(() => {
    const x = app.modalXform;
    if (x && !modal) beginModal(x.kind);
    else if (!x && modal) { modal = null; modalCenter = null; guides = []; app.cancelPreview(); }
  });

  // Install the confirm/cancel/axis/buffer hooks the modal shortcut entries call
  // (App.svelte), the same seam as canvasActions. Once, at mount. Each guards on
  // a live `modal` so a stray key outside a transform is a harmless no-op.
  $effect(() => {
    app.modalCommit = commitModal;
    app.modalCancel = cancelModal;
    app.modalSetAxis = (axis) => { if (modal) modalSetAxis(axis); };
    app.modalAppendBuffer = (ch) => { if (modal) modalAppendBuffer(ch); };
    app.modalBackspace = () => { if (modal) modalBackspace(); };
  });

  // Modifier-point drag Esc-cancel (manifest ARCHITECTURE PLAN #1: "Esc
  // cancels"). NOT routed through App.svelte's shortcut registry (out of this
  // task's fence — CanvasView owns "modifier overlay + drag kind ONLY") — a
  // dedicated CAPTURE-phase window listener, the SAME pattern SvelteLib's
  // Dropdown.svelte uses for its outside-click dismiss (document.addEventListener
  // with the capture flag). Capture matters here specifically: App.svelte's own
  // "Escape" shortcut entries dispatch on the BUBBLE phase (its
  // <svelte:window onkeydown>), and one of them (`deselect`, when:
  // editSelection) has no drag-kind guard — it would clear app.selection out
  // from under an in-progress modifier drag if it ran first. Capture always
  // runs before bubble regardless of listener registration order, so
  // stopPropagation here reliably pre-empts it — but ONLY while a modifier
  // drag is actually live (every other key, and Escape with no modifier drag
  // active, passes through untouched to App's normal dispatch).
  $effect(() => {
    const onKeydownCapture = (e) => {
      if (e.key !== "Escape" || drag?.kind !== "modifier") return;
      e.stopPropagation();
      cancelModifierDrag();
    };
    window.addEventListener("keydown", onKeydownCapture, true);
    return () => window.removeEventListener("keydown", onKeydownCapture, true);
  });

  // ANCHOR SNAP A-key tracking (manifest ARCHITECTURE PLAN #4): plain
  // (non-capturing, non-preventing) window listeners — "A" has no other
  // binding today, so this never needs to pre-empt anything, unlike the
  // Escape capture listener above. onPointerUp reads `aHeld` synchronously
  // (keyup/keydown always precede the mouseup they accompany in DOM event
  // order), so "release with A still down" is exactly "aHeld is true at the
  // moment onPointerUp runs". A window blur clears it too — an alt-tab mid-
  // drag must not leave a stuck phantom hold for the NEXT unrelated release.
  $effect(() => {
    // Ignore the A key while text is being typed into a field — otherwise typing
    // "a" in the DBLCLICK TEXT EDIT textarea (or any input) would arm anchor-snap
    // (App.onKeydown's document-level shortcut guard skips a focused TEXTAREA,
    // but this window listener is CanvasView-level and needs its own guard). Same
    // editable-target idiom as App.onKeydown.
    const typingInField = (e) => {
      const t = e.target;
      return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    const onKeydown = (e) => { if (!typingInField(e) && (e.key === "a" || e.key === "A")) aHeld = true; };
    const onKeyup = (e) => { if (e.key === "a" || e.key === "A") aHeld = false; };
    const onBlur = () => { aHeld = false; };
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("keyup", onKeyup);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("keyup", onKeyup);
      window.removeEventListener("blur", onBlur);
    };
  });

  // ── Overlay geometry (screen space) ────────────────────────────────────────

  let overlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; app.selection; app.selectionSet; app.anchorsVisible; app.showGhosts; sizeIndicators; bandRect; bandCandidates; modalCenter; app.crosshair; placeRect; placeLine; mouseWorld;
    if (!actions || !containerEl) return { outlines: [], handles: [], anchors: [], guideSegs: [], endpoints: [], modifiers: [], sizeArrows: [], band: null, bandOutlines: [], scalePivot: null, ghostOutlines: [], crosshairSegs: [], placeBox: null, placeSeg: null, multiBoxOutline: null };
    const rect = containerEl.getBoundingClientRect();
    const worldRect = {
      x: (0 - viewport.panX) / viewport.zoom,
      y: (0 - viewport.panY) / viewport.zoom,
      w: rect.width / viewport.zoom,
      h: rect.height / viewport.zoom,
    };
    const nodes = app.nodes();
    const selectedIds = app.selectedIds();
    const sel = nodes.find((n) => n.itemId === app.selection);

    /** A bbox node's screen-space outline polygon points string. */
    const outlineOf = (n) => {
      const w = n.state.w ?? 0, h = n.state.h ?? 0;
      return [[0, 0], [w, 0], [w, h], [0, h]].map(([lx, ly]) => {
        const p = T.apply(n.world, lx, ly);
        const s = actions.worldToScreen(p.x, p.y);
        return `${s.x},${s.y}`;
      }).join(" ");
    };

    // EVERY selected bbox node gets a selection outline (multi-select
    // substrate). Resize handles: a SINGLE selection gets handles on its own
    // (rotation-aware) box; a MULTI selection gets handles on its COLLECTIVE
    // world AABB (manifest UNDEFERRAL SWEEP: "multi-resize via handles" — the
    // grabbed handle drags the collective box, members scale proportionally).
    const selSet = new Set(selectedIds);
    const outlines = nodes.filter((n) => selSet.has(n.itemId) && n.plugin.capabilities.bbox).map(outlineOf);
    let handles = [], endpoints = [], multiBoxOutline = null;
    if (selectedIds.length === 1 && sel?.plugin.capabilities.bbox && sel.plugin.capabilities.resizable) {
      const w = sel.state.w ?? 0, h = sel.state.h ?? 0;
      const hs = [["tl", 0, 0], ["tm", w / 2, 0], ["tr", w, 0], ["mr", w, h / 2], ["br", w, h], ["bm", w / 2, h], ["bl", 0, h], ["ml", 0, h / 2]];
      handles = hs.map(([id, lx, ly]) => {
        const p = T.apply(sel.world, lx, ly);
        return { id, ...actions.worldToScreen(p.x, p.y) };
      });
    } else if (selectedIds.length > 1) {
      // Collective AABB of the selected nodes (only bbox/endpoint members it can
      // scale contribute — selectionAABB's own rule). Handles + a dashed box
      // outline mark the group the drag resizes.
      const box = selectionAABB(app.selectedNodes());
      if (box && box.w > 0 && box.h > 0) {
        const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
        multiBoxOutline = corners.map(([wx, wy]) => { const s = actions.worldToScreen(wx, wy); return `${s.x},${s.y}`; }).join(" ");
        const hx = box.x, hy = box.y, hw = box.w, hh = box.h;
        const hs = [["tl", hx, hy], ["tm", hx + hw / 2, hy], ["tr", hx + hw, hy], ["mr", hx + hw, hy + hh / 2], ["br", hx + hw, hy + hh], ["bm", hx + hw / 2, hy + hh], ["bl", hx, hy + hh], ["ml", hx, hy + hh / 2]];
        handles = hs.map(([id, wx, wy]) => ({ id, ...actions.worldToScreen(wx, wy) }));
      }
    }
    if (selectedIds.length <= 1 && sel?.plugin.editPoints) {
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
      for (const p of sel.plugin.editPoints(sel, byId))
        endpoints.push({ which: p.key, ...actions.worldToScreen(p.x, p.y) });
    }

    // MODIFIER POINTS (manifest ARCHITECTURE PLAN #1): the SELECTED item's
    // yellow squares only — same single-selection scope as resize handles/
    // edit points (a multi-selection has no single widget's parameter to
    // scrub). nodeModifierPoints already wraps local→world through node.world,
    // so rotation/scale need no special handling here — same as anchors.
    const modifiers = selectedIds.length === 1 && sel
      ? nodeModifierPoints(sel).map((m) => ({ id: m.id, ...actions.worldToScreen(m.x, m.y) }))
      : [];

    // In-progress rubber band: the box itself (world-axis-aligned, so two
    // corners suffice) + preview outlines on the current candidates.
    let band = null, bandOutlines = [];
    if (bandRect) {
      const a = actions.worldToScreen(bandRect.x, bandRect.y);
      const b = actions.worldToScreen(bandRect.x + bandRect.w, bandRect.y + bandRect.h);
      band = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      const candSet = new Set(bandCandidates);
      bandOutlines = nodes.filter((n) => candSet.has(n.itemId)).map(outlineOf);
    }

    const anchors = (app.anchorsVisible ? nodes : []).flatMap((n) =>
      nodeAnchors(n).map((a) => actions.worldToScreen(a.x, a.y)));

    // GHOST-OUTLINE (manifest ARCHITECTURE PLAN #2): widgets with no rendered
    // volume draw a thin outline so they stay selectable. Crop boxes show
    // ALWAYS (unclickable otherwise — the spec's "outline always visible in
    // the editor"); other ghosts (future: empty text, groups) only when the
    // "Show Ghosts" toggle is on. Editor-only chrome — never reaches sceneIR/
    // the GPU composite, so it never exports/presents.
    const ghostOutlines = nodes
      .filter((n) => isGhostNode(n) && n.plugin.capabilities.bbox && (n.type === "cropbox" || app.showGhosts))
      .map(outlineOf);

    const guideSegs = guides.flatMap((g) => {
      if (g.kind === "point") {
        const p = actions.worldToScreen(g.x, g.y);
        return [{ kind: "point", x: p.x, y: p.y }];
      }
      const seg = clipLineToRect(g.x, g.y, g.dx, g.dy, worldRect);
      if (!seg) return [];
      const a = actions.worldToScreen(seg[0], seg[1]);
      const b = actions.worldToScreen(seg[2], seg[3]);
      return [{ kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y }];
    });

    // Matching-dimension two-way arrows: a width match draws horizontally
    // across the object's width at its vertical center; a height match draws
    // vertically at its horizontal center. Both endpoints get arrowheads.
    const sizeArrows = sizeIndicators.map((ind) => {
      const [wx1, wy1, wx2, wy2] = ind.axis === "w"
        ? [ind.x, ind.y + ind.h / 2, ind.x + ind.w, ind.y + ind.h / 2]
        : [ind.x + ind.w / 2, ind.y, ind.x + ind.w / 2, ind.y + ind.h];
      const a = actions.worldToScreen(wx1, wy1);
      const b = actions.worldToScreen(wx2, wy2);
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    });

    // The S-modal scale pivot (the selection's collective center) — a small
    // dot marking what the scale grows/shrinks about (reuses the guide-point
    // affordance; no new styling).
    const scalePivot = modalCenter ? actions.worldToScreen(modalCenter.x, modalCenter.y) : null;

    // CROSSHAIR MODE (manifest ARCHITECTURE PLAN #5 — "one mechanism, two
    // skins"): while a mode is ARMED (before the gesture starts — `drag` is
    // still null at this point in a plain hover, since a live band/place drag
    // clears app.crosshair on pointer-down) and the cursor is over the
    // canvas, draw FULL-VIEWPORT infinite crosshairs through the cursor's
    // world point — THE ONE guide pipeline (clipLineToRect against the same
    // worldRect guides/anchors already use), not a second geometry path.
    // Skin is carried alongside each segment so the template picks the CSS
    // class (band = dashed band-select styling; place = --a-ghost gray) with
    // no duplicated line-building code between the two.
    const crosshairSegs = app.crosshair && mouseWorld
      ? [
          clipLineToRect(mouseWorld.x, mouseWorld.y, 1, 0, worldRect),
          clipLineToRect(mouseWorld.x, mouseWorld.y, 0, 1, worldRect),
        ].filter(Boolean).map((seg) => {
          const a = actions.worldToScreen(seg[0], seg[1]);
          const b = actions.worldToScreen(seg[2], seg[3]);
          return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, skin: app.crosshair.kind };
        })
      : [];

    // In-progress PLACEMENT preview rect (gray, manifest ARCHITECTURE PLAN
    // #5): same corner-normalizing shape as the band-select box (`band`
    // above), so the template's rect math is identical between the two
    // skins — only the CSS class differs.
    let placeBox = null;
    if (placeRect) {
      const a = actions.worldToScreen(placeRect.x, placeRect.y);
      const b = actions.worldToScreen(placeRect.x + placeRect.w, placeRect.y + placeRect.h);
      placeBox = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    }

    // In-progress ENDPOINT-placement preview segment (arrow Add buttons): the
    // from→to line a release right now would place, in screen space.
    let placeSeg = null;
    if (placeLine) {
      const a = actions.worldToScreen(placeLine.x1, placeLine.y1);
      const b = actions.worldToScreen(placeLine.x2, placeLine.y2);
      placeSeg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }

    return { outlines, handles, anchors, guideSegs, endpoints, modifiers, sizeArrows, band, bandOutlines, scalePivot, ghostOutlines, crosshairSegs, placeBox, placeSeg, multiBoxOutline };
  });

  // TRUE IN-PLACE EDIT: the derived node of the item being edited (or null). The
  // TextEditController renders in the item's world pose off THIS node (preview-
  // blended state, so live edits show as you type). Recomputes on
  // doc/preview/slide/viewport change (the `overlay` reactive-deps pattern). Null
  // if the item was purged/retyped mid-edit — the overlay unmounts, the commit
  // still lands off the last preview.
  let textEditNode = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; // reactive deps (match `overlay`)
    if (!app.textEditing || !actions) return null;
    const n = app.nodes().find((nn) => nn.itemId === app.textEditing.itemId);
    return (n && n.type === "text") ? n : null;
  });
</script>

<!-- Rulers are chrome OUTSIDE the render area (user's structural fix): when the
     ruler is on, .canvas-wrap gains .with-rulers which insets .render-area by
     the ruler thickness on top/left. The rulers occupy the freed gutter. Because
     .render-area is the PanZoom's frame AND every mouse/tick measurement is made
     against it, the ruler SVG's local origin coincides with the render origin —
     so markers align EXACTLY with the cursor at every zoom/pan (no thickness
     offset; the old bug came from the rulers overlapping the render area). -->
<div class="canvas-wrap" class:with-rulers={app.rulerEnabled}>
  <div class="render-area" bind:this={containerEl} bind:clientWidth={wrapW} bind:clientHeight={wrapH}>
  <PanZoom {onviewport}>
    {#snippet children(vp, a)}
      {bindActions(a)}
      <!-- Blender-style grid on its OWN underlay canvas, beneath .scene; the
           compositor never sees it (editor-only chrome). -->
      <canvas bind:this={gridEl} class="grid-underlay"></canvas>
      <canvas bind:this={canvasEl} class="scene"></canvas>
      {#if gpuError}
        <!-- No render fallback by decree (manifest RENDER MODES DECISION) —
             the failure is loud and names itself. -->
        <div class="gpu-error">Renderer init failed — cannot render. {gpuError}</div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        class="overlay"
        bind:this={overlayEl}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onpointerleave={onPointerLeave}
        ondblclick={onDblClick}
        ondragover={onCanvasDragOver}
        ondrop={onCanvasDrop}
      >
        <defs>
          <!-- Two-way arrowheads for matching-dimension indicators; markers
               inherit the line's guide stroke via context-stroke. -->
          <marker id="size-arrow-start" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M6,1 L1,4 L6,7" fill="none" stroke="context-stroke" stroke-width="1.5" />
          </marker>
          <marker id="size-arrow-end" markerWidth="8" markerHeight="8" refX="2" refY="4" orient="auto">
            <path d="M2,1 L7,4 L2,7" fill="none" stroke="context-stroke" stroke-width="1.5" />
          </marker>
        </defs>
        <!-- CROSSHAIR MODE (manifest ARCHITECTURE PLAN #5): full-viewport
             infinite lines through the cursor while a mode is ARMED (before
             the gesture starts — they vanish once you click, since drag
             starting clears app.crosshair and no live drag repopulates this
             array). Skin picks the CSS class: band = dashed band-select
             style, place = gray --a-ghost tone. -->
        {#each overlay.crosshairSegs as c}
          <line class="crosshair" class:crosshair-band={c.skin === "band"} class:crosshair-place={c.skin === "place"} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} />
        {/each}
        {#each overlay.guideSegs as g}
          {#if g.kind === "line"}
            <line class="guide" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
          {:else}
            <circle class="guide-point" cx={g.x} cy={g.y} r="4" />
          {/if}
        {/each}
        {#if overlay.scalePivot}
          <!-- The S-modal scale pivot (selection's collective center). -->
          <circle class="guide-point" cx={overlay.scalePivot.x} cy={overlay.scalePivot.y} r="4" />
        {/if}
        {#each overlay.sizeArrows as s}
          <line
            class="size-arrow"
            x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            marker-start="url(#size-arrow-start)"
            marker-end="url(#size-arrow-end)"
          />
        {/each}
        <!-- GHOST-OUTLINE (manifest ARCHITECTURE PLAN #2): thin 50%-gray
             boundary so ghosts (no rendered volume of their own — crop boxes
             ALWAYS, other ghosts behind the "Show Ghosts" toggle) stay
             clickable. Editor-only chrome — never reaches the GPU composite
             (never exports/presents). Drawn BELOW the selection outline so a
             selected ghost still reads as selected on top of it. -->
        {#each overlay.ghostOutlines as o}
          <polygon class="ghost-outline" points={o} />
        {/each}
        {#each overlay.outlines as o}
          <polygon class="selection" points={o} />
        {/each}
        {#if overlay.multiBoxOutline}
          <!-- The collective AABB a multi-selection resizes (manifest UNDEFERRAL
               SWEEP: multi-resize via handles). Drawn as a selection outline so
               it reads as the group's bounding box; the 8 handles sit on it. -->
          <polygon class="selection multiselect-box" points={overlay.multiBoxOutline} />
        {/if}
        {#if overlay.placeBox}
          <!-- In-progress CROSSHAIR PLACEMENT drag rect (manifest ARCHITECTURE
               PLAN #5): the exact box a release right now would place. -->
          <rect class="place-rect" x={overlay.placeBox.x} y={overlay.placeBox.y} width={overlay.placeBox.w} height={overlay.placeBox.h} />
        {/if}
        {#if overlay.placeSeg}
          <!-- In-progress ENDPOINT PLACEMENT drag segment (arrow Add buttons,
               manifest UNDEFERRAL SWEEP): the exact from→to line a release now
               would place. Reuses the .place-rect skin (same gray placement
               tone) so the two placement kinds read as one mechanism. -->
          <line class="place-rect" x1={overlay.placeSeg.x1} y1={overlay.placeSeg.y1} x2={overlay.placeSeg.x2} y2={overlay.placeSeg.y2} />
        {/if}
        {#if overlay.band}
          <!-- The in-progress rubber band + preview outlines on the items the
               current box would select (live band-select feedback). -->
          <rect class="band-rect" x={overlay.band.x} y={overlay.band.y} width={overlay.band.w} height={overlay.band.h} />
        {/if}
        {#each overlay.bandOutlines as o}
          <polygon class="band-candidate" points={o} />
        {/each}
        <ResizeHandles handles={overlay.handles} onstart={startResize} />
        {#each overlay.endpoints as ep}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <circle
            class="endpoint"
            cx={ep.x} cy={ep.y} r="6"
            onpointerdown={(e) => startEndpoint(ep.which, e)}
          />
        {/each}
        {#each overlay.modifiers as m}
          <!-- MODIFIER POINTS (manifest ARCHITECTURE PLAN #1 — "the PPT
               yellow squares"): drawn as a square (not the endpoints' circle)
               at the SAME 8px footprint as ResizeHandles, so the three handle
               families (blue resize squares, amber endpoint dots, yellow
               modifier squares) are each visually distinct at a glance. -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <rect
            class="modifier"
            x={m.x - 4} y={m.y - 4} width="8" height="8"
            onpointerdown={(e) => startModifier(m.id, e)}
          />
        {/each}
        {#each overlay.anchors as a}
          <g class="anchor" transform={`translate(${a.x} ${a.y})`}>
            <line x1="-5" y1="-5" x2="5" y2="5" />
            <line x1="-5" y1="5" x2="5" y2="-5" />
          </g>
        {/each}
        {#if dynamicAnchor && actions}
          {@const dp = actions.worldToScreen(dynamicAnchor.x, dynamicAnchor.y)}
          <!-- # marks a COMPUTED anchor (its position is a live function — the
               closest-point-on-perimeter tracking the dragged endpoint), vs
               the preset anchors' X. Same .anchor stroke/opacity styling and
               the same 10px glyph box as the X's. -->
          <g class="anchor" transform={`translate(${dp.x} ${dp.y})`}>
            <line x1="-2" y1="-5" x2="-2" y2="5" />
            <line x1="2" y1="-5" x2="2" y2="5" />
            <line x1="-5" y1="-2" x2="5" y2="-2" />
            <line x1="-5" y1="2" x2="5" y2="2" />
          </g>
        {/if}
        {#if hoverAnchor && actions}
          {@const tp = actions.worldToScreen(hoverAnchor.x, hoverAnchor.y)}
          <g class="anchor-tip" transform={`translate(${tp.x} ${tp.y})`}>
            <text x="10" y="18">{hoverAnchor.label}</text>
          </g>
        {/if}
      </svg>
      {#if textEditNode && actions && gpu}
        <!-- TRUE in-place rich-text editor: caret + selection are SELF-DRAWN from
             the SAME CanvasKit Paragraph the render draws (via the shared `gpu`
             SkiaSurface's CanvasKit + fontCollection), so they land on the glyphs
             across mixed runs with no browser-layout drift. Skia keeps rendering
             the item live (paint() does NOT suppress it), so there is no double
             image / exit jump. Drives the whole edit lifecycle (preview/commit/
             cancel, per-run + per-paragraph style, the floating toolbar).
             worldToScreen/screenToWorld are the camera maps; zoom·world.scale maps
             the local layout to screen. -->
        <TextEditController
          {app}
          node={textEditNode}
          {gpu}
          worldToScreen={actions.worldToScreen}
          screenToWorld={actions.screenToWorld}
          zoom={viewport.zoom}
        />
      {/if}
      {#if app.minimapVisible}
        <div class="minimap-dock">
          <MiniMap
            {viewport}
            containerWidth={wrapW}
            containerHeight={wrapH}
            worldBounds={{ x: minimapCamRect.x, y: minimapCamRect.y, w: minimapCamRect.w, h: minimapCamRect.h }}
          >
            {#snippet children()}
              {#if minimapThumb}
                <!-- The camera-frame content, placed at the CAMERA rect's world
                     coords (the MiniMap viewBox scales it). Rebased off the raw
                     slide rect so the minimap shows what the camera frames. -->
                <image
                  href={minimapThumb}
                  x={minimapCamRect.x}
                  y={minimapCamRect.y}
                  width={minimapCamRect.w}
                  height={minimapCamRect.h}
                  preserveAspectRatio="none"
                />
              {/if}
            {/snippet}
          </MiniMap>
        </div>
      {/if}
    {/snippet}
  </PanZoom>
  </div>

  <!-- Rulers: chrome in the gutter OUTSIDE .render-area. Each ruler SVG shares
       .render-area's x/y origin (same left/top offset in .canvas-wrap), so tick
       positions and the mouse marker — both in the render-area frame — land at
       the same screen x/y as the cursor. World-px tick labels come from ticks.js
       and cross-fade with zoom (same partition-of-unity math as the grid); the
       marker readout is $derived from screenMouse + view (updates on pan/zoom).
       pointer-events:none so a ruler never blocks canvas interaction. -->
  {#if app.rulerEnabled}
    <!-- Top + left rulers joined by a corner square (user spec).
         Marker labels knock out underlying tick labels via paint-order stroke. -->
    <div class="ruler ruler-top">
      <svg class="ruler-svg" width="100%" height="100%">
        {#each rulerX as t}
          <line class="ruler-tick" x1={t.s} y1="0" x2={t.s} y2="100%" opacity={t.opacity} />
          <text class="ruler-label" x={t.s + 3} y="10" opacity={t.opacity}>{t.w}</text>
        {/each}
        {#if mouseMarkerX != null}
          <line class="ruler-marker" x1={mouseMarkerX} y1="0" x2={mouseMarkerX} y2="100%" />
          <text class="ruler-marker-label" x={mouseMarkerX + 3} y="10">{Math.round(mouseWorld.x)}</text>
        {/if}
      </svg>
    </div>
    <div class="ruler ruler-left">
      <svg class="ruler-svg" width="100%" height="100%">
        {#each rulerY as t}
          <line class="ruler-tick" x1="0" y1={t.s} x2="100%" y2={t.s} opacity={t.opacity} />
          <text class="ruler-label" x="2" y={t.s - 3} opacity={t.opacity}>{t.w}</text>
        {/each}
        {#if mouseMarkerY != null}
          <line class="ruler-marker" x1="0" y1={mouseMarkerY} x2="100%" y2={mouseMarkerY} />
          <text class="ruler-marker-label" x="2" y={mouseMarkerY - 3}>{Math.round(mouseWorld.y)}</text>
        {/if}
      </svg>
    </div>
    <div class="ruler-corner"></div>
  {/if}
</div>

<!-- Styling lives in app.css (app convention: no <style> blocks in app components). -->
