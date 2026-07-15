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
  import PanZoom from "../../../lib/PanZoom.svelte";
  import MiniMap from "../../../lib/MiniMap.svelte";
  import ResizeHandles from "./ResizeHandles.svelte";
  import { pickNode, nodeFeatures, nodeAnchors, deriveRenderTree, cameraRect, worldTransform, stateXYForCenterPivotWorld } from "../core/derive.js";
  import { solveSnap, solveEdgeSnap, sizeMatches, axisLock } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  import { THUMB_W, worldViewRect, canSkipNode } from "../core/view.js";
  import { selectInBox, rectFromCorners } from "../core/bandselect.js";
  import { sceneIR } from "../render_gpu/ports.js";
  import { rect as rectCmd, parseColor } from "../render_gpu/ir.js";
  import { GpuCompositor } from "../render_gpu/gpu/compositor.js";
  import { onImageLoad } from "../render_gpu/gpu/image_registry.js";
  import { onVideoFrame } from "../render_gpu/gpu/video_registry.js";
  import { renderViewFrame } from "./gpuService.js";
  import * as T from "../core/transform.js";
  import { visibleLevels, ticksInRange } from "../../../lib/ticks.js";
  import { ASSET_DRAG_MIME } from "./projectApi.js"; // asset-tile drop payload type (drop-handler region)

  let { app } = $props();

  const SNAP_PX = 8; // THE one uniform snap threshold (user rule): drag snap, resize snap, anchor bind, border grab (value PENDING USER RATIFICATION)
  const MIN_SIZE = 0; // sizes are non-negative — a mathematical bound, not a design choice
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
  let minimapThumb = $state(""); // data URL of the current slide, for the minimap
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
  // THE renderer (manifest "RENDER MODES DECISION"): the content canvas is
  // WebGPU — no canvas2D mode survives. Init is async; the first paint fires
  // when `gpu` lands (it's a dep of the paint effect). Failure is LOUD and
  // user-visible: no fallback by decree, the app shows what went wrong.
  let gpu = $state(null);
  let gpuError = $state(null);
  $effect(() => {
    if (!canvasEl || gpu || gpuError) return;
    // premultiplied: the editor's transparent clear must show the grid
    // underlay + app background beneath the canvas (opaque rendered it black).
    GpuCompositor.create(canvasEl, { alphaMode: "premultiplied" })
      .then((g) => (gpu = g))
      .catch((e) => {
        gpuError = String(e?.message ?? e);
        console.error("PowerRP: WebGPU init failed:", e);
      });
  });

  $effect(() => {
    app.doc; app.slideIndex; app.previewDelta; app.anchorsVisible; viewport; wrapW; wrapH; gpu; imageEpoch;
    paint();
  });

  // Minimap thumbnail: THE renderer, small, via the shared pixel service.
  // Skipped while dragging (previewDelta churn) — refreshed on commit. Async:
  // last write wins (commits are far slower than renders).
  $effect(() => {
    app.doc; app.slideIndex; app.minimapVisible;
    if (!app.minimapVisible || app.previewDelta) return;
    const meta = app.doc.meta;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const cssH = Math.round((THUMB_W * meta.slideH) / meta.slideW);
    renderViewFrame(app.doc, {
      slideIndex: app.slideIndex,
      alpha: 1,
      registry: app.registry,
      width: Math.round(THUMB_W * dpr),
      height: Math.round(cssH * dpr),
      view: { zoom: THUMB_W / meta.slideW, panX: 0, panY: 0, dpr },
    }).then((thumb) => (minimapThumb = thumb.toDataURL("image/png")));
  });

  function paint() {
    if (!canvasEl || !containerEl || !gpu) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const rect = containerEl.getBoundingClientRect();
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
    const nodes = deriveRenderTree(state, app.registry).filter((n) => !canSkipNode(n, viewRect));
    // The camera's background shows in the editor too (round 11: "I can't
    // see it in the main editing area") — first draw, under all content;
    // outside the camera bbox the transparent clear keeps the app background
    // visible, exactly like the old clearRect + canvas2D path.
    const camRect = cameraRect(state, app.doc.meta);
    const ir = [
      rectCmd({ x: camRect.x, y: camRect.y, w: camRect.w, h: camRect.h, fill: parseColor(camRect.background) }),
      ...sceneIR(nodes),
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

  // ── Selection + drag ────────────────────────────────────────────────────────

  /**
   * The translatable members of the current selection, each captured with the
   * data a body-drag/modal-grab needs: its plugin, its RAW stored item (so
   * equation-bound coords are recognized as strings and stay anchored), and its
   * numeric start x/y. Shared by DRAG-ALL and the G/S modal transforms so the
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
      }));
  }

  /**
   * Pure function. The path/value preview pairs that translate one member by a
   * world delta (dx, dy) — the ONE translation rule shared by DRAG-ALL body
   * drags and modal grab. A moveBy widget (arrow) translates only its FREE
   * numeric coordinates via its plugin hook (bound endpoints stay anchored); a
   * bbox/transform widget writes plain numeric x/y (direct manipulation
   * replaces any equation on x/y outright — the established body-drag rule).
   */
  function translationPairs(member, dx, dy) {
    if (member.plugin.moveBy)
      return member.plugin.moveBy(member.rawItem, dx, dy)
        .map(([p, v]) => [["items", member.itemId, ...p], v]);
    return [
      [["items", member.itemId, "x"], member.startX + dx],
      [["items", member.itemId, "y"], member.startY + dy],
    ];
  }

  function onPointerDown(e) {
    if (e.button !== 0 || app.mode !== "edit") return;
    // A left click CONFIRMS an active modal transform (Blender precedent) and
    // consumes the event — it must NOT start a new pick/drag underneath.
    if (modal) {
      commitModal();
      return;
    }
    const w = worldPoint(e);
    // Armed rubber-band select (palette "Select in Box …") consumes the
    // ONE-SHOT arm: this drag is a band, not a pick/move. The mode was already
    // resolved at arm time ("regular" → the bandMode browser setting), so a
    // future drag-on-empty-canvas entry point starts this same drag kind
    // directly with mode = app.bandMode — no arming required.
    if (app.bandArm) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag = { kind: "band", mode: app.bandArm, startWorld: w, lastWorld: w };
      app.bandArm = null;
      bandRect = rectFromCorners(w, w);
      bandCandidates = [];
      hoverAnchor = null; // a hover tip must not linger frozen through the drag
      app.dragging = true;
      app.dragKind = "band";
      return;
    }
    const nodes = app.nodes();
    const hit = pickNode(nodes, w.x, w.y, SNAP_PX / viewport.zoom);
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
    else if (drag.kind === "endpoint") endpointDrag(w);
    else if (drag.kind === "band") bandDrag(w);
    // "shiftpick" = a deferred shift-click on a NON-draggable item: no drag
    // behavior, only the slop tracking above, so the pointer path does nothing.
  }

  // ── Rubber-band selection drag ─────────────────────────────────────────────

  /**
   * Command (updates band preview state). Recomputes the world-space band rect
   * and the live CANDIDATE set — the items the current box would select in the
   * drag's mode (core/bandselect.js: INNER = fully enclosed by the box, OUTER =
   * touching counts; bounds = the conservative rotated world AABB). Candidates
   * render as preview outlines; the selection itself is applied on pointer-up.
   */
  function bandDrag(w) {
    drag.lastWorld = w;
    bandRect = rectFromCorners(drag.startWorld, w);
    bandCandidates = selectInBox(app.nodes(), bandRect, drag.mode);
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
        const features = nodes.filter((n) => n.itemId !== drag.itemId).flatMap(nodeFeatures);
        const tol = SNAP_PX / viewport.zoom;
        const snap = solveSnap(probes, features, tol);
        dx += snap.dx;
        dy += snap.dy;
        newGuides.push(...snap.guides);
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
    const pairs = drag.members.flatMap((m) => translationPairs(m, dx, dy));
    if (pairs.length) app.setPreview(pairs);
  }

  // ── Resize ──────────────────────────────────────────────────────────────────

  /**
   * Pure function. The grabbed point and fixed (anchor) point of a handle
   * resize, in the box's local frame — ONE computation shared by the resize
   * math (resizedBox) and the uniform diagonal guide, so they never disagree.
   *
   * gx/gy is the grabbed corner (on an axis with no grabbed edge it holds the
   * far coordinate, unused there); fx/fy is the point the resize is anchored
   * to — the opposite corner/edge, or the box CENTER when `symmetric` (Cmd).
   *
   * @example // resizeAnchors([0, 0, 100, 50], {east: true, south: true}, {})
   * //   → {gx: 100, gy: 50, fx: 0, fy: 0, cx: 50, cy: 25, xActive: true, yActive: true}
   * @example // resizeAnchors([0, 0, 100, 50], {east: true}, {symmetric: true}).fx → 50
   */
  function resizeAnchors([x0, y0, x1, y1], edges, mods) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return {
      gx: edges.west ? x0 : x1,
      gy: edges.north ? y0 : y1,
      fx: mods.symmetric ? cx : edges.west ? x1 : x0,
      fy: mods.symmetric ? cy : edges.north ? y1 : y0,
      cx, cy,
      xActive: !!(edges.east || edges.west),
      yActive: !!(edges.north || edges.south),
    };
  }

  /**
   * Pure function. The resized box for a handle drag with modifiers, in the
   * item's local frame (`base` = the box at the last modifier rebase).
   *
   * Modifier semantics (manifest "Drag/resize modifiers — CONFIRMED mapping"):
   *   uniform (Shift)  — ONE scale factor K for both dimensions. A corner
   *     rides the diagonal through the anchor (the pointer projects onto it);
   *     an edge handle drives K from its own axis, and the passive axis
   *     scales about its center — the only symmetric-neutral choice for an
   *     axis with no grabbed edge (Figma's Shift+edge precedent).
   *   symmetric (Cmd)  — the anchor is the box CENTER, so both sides move
   *     (PowerPoint's Ctrl-resize precedent). Composes with uniform: the
   *     corner then rides the FULL diagonal, scaling about the center.
   *
   * Sizes never invert (MIN_SIZE = 0, the mathematical bound): K clamps at 0
   * (collapse onto the anchor); free edges stop at theirs.
   *
   * Args:
   *   base  (number[4]): [x0, y0, x1, y1] box at the last modifier rebase
   *   d     ({x, y}):    local pointer movement since that rebase
   *   edges (object):    {west, east, north, south} — edges the handle moves
   *   mods  (object):    {uniform, symmetric}
   *
   * Returns:
   *   number[4]: the new [x0, y0, x1, y1]
   *
   * @example // resizedBox([0,0,100,50], {x:20,y:0}, {east:true}, {}) → [0, 0, 120, 50]
   * @example // resizedBox([0,0,100,50], {x:20,y:0}, {east:true}, {symmetric:true}) → [-20, 0, 120, 50]
   * @example // resizedBox([0,0,100,50], {x:100,y:0}, {east:true,south:true}, {uniform:true}) → [0, 0, 180, 90]
   * @example // resizedBox([0,0,100,50], {x:-200,y:0}, {east:true}, {}) → [0, 0, 0, 50] (clamped at the fixed edge)
   */
  function resizedBox(base, d, edges, mods) {
    const [bx0, by0, bx1, by1] = base;
    const { gx, gy, fx, fy, cx, cy, xActive, yActive } = resizeAnchors(base, edges, mods);

    if (mods.uniform) {
      const ux = gx - fx, uy = gy - fy;
      const len2 = xActive && yActive ? ux * ux + uy * uy : xActive ? ux * ux : uy * uy;
      if (len2 > 0) {
        const K = Math.max(0, (xActive && yActive
          ? (gx + d.x - fx) * ux + (gy + d.y - fy) * uy
          : xActive ? (gx + d.x - fx) * ux : (gy + d.y - fy) * uy) / len2);
        const ax = xActive ? fx : cx, ay = yActive ? fy : cy;
        return [ax + K * (bx0 - ax), ay + K * (by0 - ay), ax + K * (bx1 - ax), ay + K * (by1 - ay)];
      }
      // Zero extent along the drive: no aspect to preserve — fall through.
    }

    let x0 = bx0, y0 = by0, x1 = bx1, y1 = by1;
    if (edges.east) x1 += d.x;
    if (edges.west) x0 += d.x;
    if (edges.south) y1 += d.y;
    if (edges.north) y0 += d.y;
    if (mods.symmetric) {
      // The opposite edge mirrors the moved one about the center.
      if (edges.east) x0 = 2 * cx - x1;
      if (edges.west) x1 = 2 * cx - x0;
      if (edges.south) y0 = 2 * cy - y1;
      if (edges.north) y1 = 2 * cy - y0;
    }
    if (x1 < x0) x0 = x1 = mods.symmetric ? cx : fx;
    if (y1 < y0) y0 = y1 = mods.symmetric ? cy : fy;
    return [x0, y0, x1, y1];
  }

  function startResize(handleId, e) {
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
    if (!drag.rotated && app.snapEnabled && !mods.uniform && !mods.symmetric) {
      const r = applyResizeSnap({ x, y, ww, hh });
      x = r.x; y = r.y; ww = r.ww; hh = r.hh;
      newGuides = r.guides;
      indicators = r.indicators;
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
   * Snaps an in-progress axis-aligned resize. Returns corrected {x,y,ww,hh},
   * the aligned line `guides`, and matching-dimension `indicators`. The moving
   * edges snap to other nodes' infinite lines (solveEdgeSnap); when the master
   * item's width/height lands within tolerance of another VISIBLE bbox item's
   * same dimension it snaps EXACTLY to it (sizeMatches, gated on snapSizeEnabled)
   * and every matching object gets a two-way-arrow indicator across its span.
   * Raises app.snapEngaged whenever any correction is applied.
   *
   * Near-pure (mutates app.snapEngaged and reads app scene state); geometry
   * itself is world-space and deterministic.
   */
  function applyResizeSnap({ x, y, ww, hh }) {
    const scale = drag.world.scale;
    const tol = SNAP_PX / viewport.zoom;
    const others = app.nodes().filter((n) => n.itemId !== drag.itemId);
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
    return { x, y, ww, hh, guides, indicators };
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
      const nodes = app.nodes().filter((n) => n.itemId !== drag.itemId);
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

  function onPointerLeave() {
    if (!drag && !modal) screenMouse = null; // hide ruler markers on leave (not mid-gesture)
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.kind === "band") {
      // Apply the band: recomputed from the drag's own endpoints (not the
      // render preview) so the result is deterministic. selectMany sets the
      // multi-selection (primary = first hit); an empty result deselects.
      app.selectMany(selectInBox(app.nodes(), rectFromCorners(drag.startWorld, drag.lastWorld), drag.mode));
      bandRect = null;
      bandCandidates = [];
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
  function selectionCenter(nodes) {
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
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
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

  /**
   * Pure function. Preview pairs that scale one member by `factor` about world
   * center `c`, optionally constrained to one `axis` ("x" → width + x-position
   * only; "y" → height + y-position only; null → uniform). A bbox/transform
   * widget scales its w/h AND repositions its x/y about the center (a true
   * size+position scale, honest to the w/h the inspector shows — the resize
   * path's convention). A moveBy widget (arrow) scales each FREE numeric
   * endpoint about the center; equation-bound endpoints stay put. NOTE: for
   * ROTATED / non-unit-scale bbox items the x/y scaling uses the stored
   * (base-frame) coordinates, so the pivot is exact only for unrotated items —
   * full rotation-aware modal scale is deferred to the rotation sweep (out of
   * this task's scope; flagged).
   */
  function scalePairs(member, factor, c, axis = null) {
    const doX = axis !== "y"; // x-axis constraint (or unconstrained) touches x/w
    const doY = axis !== "x"; // y-axis constraint (or unconstrained) touches y/h
    if (member.plugin.moveBy) {
      const s = member.rawItem ?? {};
      const pairs = [];
      for (const end of ["from", "to"])
        for (const coord of ["x", "y"]) {
          if (coord === "x" ? !doX : !doY) continue;
          const v = s[end]?.[coord];
          if (typeof v === "number") {
            const cc = coord === "x" ? c.x : c.y;
            pairs.push([["items", member.itemId, end, coord], cc + factor * (v - cc)]);
          }
        }
      return pairs;
    }
    const rawItem = member.rawItem ?? {};
    const w = typeof rawItem.w === "number" ? rawItem.w : null;
    const h = typeof rawItem.h === "number" ? rawItem.h : null;
    const pairs = [];
    if (doX) pairs.push([["items", member.itemId, "x"], c.x + factor * (member.startX - c.x)]);
    if (doY) pairs.push([["items", member.itemId, "y"], c.y + factor * (member.startY - c.y)]);
    if (doX && w !== null) pairs.push([["items", member.itemId, "w"], w * factor]);
    if (doY && h !== null) pairs.push([["items", member.itemId, "h"], h * factor]);
    return pairs;
  }

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

  // ── Overlay geometry (screen space) ────────────────────────────────────────

  let overlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; app.selection; app.selectionSet; app.anchorsVisible; sizeIndicators; bandRect; bandCandidates; modalCenter;
    if (!actions || !containerEl) return { outlines: [], handles: [], anchors: [], guideSegs: [], endpoints: [], sizeArrows: [], band: null, bandOutlines: [], scalePivot: null };
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
    // substrate); resize handles and edit points only for a SINGLE selection
    // (manifest: "resize handles only for a single selection").
    const selSet = new Set(selectedIds);
    const outlines = nodes.filter((n) => selSet.has(n.itemId) && n.plugin.capabilities.bbox).map(outlineOf);
    let handles = [], endpoints = [];
    if (selectedIds.length === 1 && sel?.plugin.capabilities.bbox && sel.plugin.capabilities.resizable) {
      const w = sel.state.w ?? 0, h = sel.state.h ?? 0;
      const hs = [["tl", 0, 0], ["tm", w / 2, 0], ["tr", w, 0], ["mr", w, h / 2], ["br", w, h], ["bm", w / 2, h], ["bl", 0, h], ["ml", 0, h / 2]];
      handles = hs.map(([id, lx, ly]) => {
        const p = T.apply(sel.world, lx, ly);
        return { id, ...actions.worldToScreen(p.x, p.y) };
      });
    }
    if (selectedIds.length <= 1 && sel?.plugin.editPoints) {
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
      for (const p of sel.plugin.editPoints(sel, byId))
        endpoints.push({ which: p.key, ...actions.worldToScreen(p.x, p.y) });
    }

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

    return { outlines, handles, anchors, guideSegs, endpoints, sizeArrows, band, bandOutlines, scalePivot };
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
        <div class="gpu-error">WebGPU unavailable — cannot render. {gpuError}</div>
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
        {#each overlay.outlines as o}
          <polygon class="selection" points={o} />
        {/each}
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
      {#if app.minimapVisible}
        <div class="minimap-dock">
          <MiniMap
            {viewport}
            containerWidth={wrapW}
            containerHeight={wrapH}
            worldBounds={{ x: 0, y: 0, w: app.doc.meta.slideW, h: app.doc.meta.slideH }}
          >
            {#snippet children()}
              {#if minimapThumb}
                <image
                  href={minimapThumb}
                  x="0" y="0"
                  width={app.doc.meta.slideW}
                  height={app.doc.meta.slideH}
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
