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
  import { pickNode, nodeFeatures, nodeAnchors, deriveRenderTree, cameraRect, worldTransform } from "../core/derive.js";
  import { solveSnap, solveEdgeSnap, sizeMatches, axisLock } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  import { THUMB_W, worldViewRect, canSkipNode } from "../core/view.js";
  import { foldState } from "../core/document.js";
  import { blendApplied } from "../core/deltas.js";
  import { evaluateState } from "../core/expressions.js";
  import { sceneIR } from "../render_gpu/ports.js";
  import { rect as rectCmd, parseColor } from "../render_gpu/ir.js";
  import { GpuCompositor } from "../render_gpu/gpu/compositor.js";
  import { renderViewFrame } from "./gpuService.js";
  import * as T from "../core/transform.js";
  import { visibleLevels, ticksInRange } from "../../../lib/ticks.js";

  let { app } = $props();

  const SNAP_PX = 8; // THE one uniform snap threshold (user rule): drag snap, resize snap, anchor bind, border grab (value PENDING USER RATIFICATION)
  const MIN_SIZE = 0; // sizes are non-negative — a mathematical bound, not a design choice

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
  let hoverAnchor = $state(null);
  let drag = null; // non-reactive drag bookkeeping

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
    GpuCompositor.create(canvasEl)
      .then((g) => (gpu = g))
      .catch((e) => {
        gpuError = String(e?.message ?? e);
        console.error("PowerRP: WebGPU init failed:", e);
      });
  });

  $effect(() => {
    app.doc; app.slideIndex; app.previewDelta; app.anchorsVisible; viewport; wrapW; wrapH; gpu;
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
    let state = foldState(app.doc, app.slideIndex, 1);
    if (app.previewDelta) state = blendApplied(state, app.previewDelta, 1);
    state = evaluateState(state, app.registry).state;
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

  // ── Selection + drag ────────────────────────────────────────────────────────

  function onPointerDown(e) {
    if (e.button !== 0 || app.mode !== "edit") return;
    const w = worldPoint(e);
    const nodes = app.nodes();
    const hit = pickNode(nodes, w.x, w.y, SNAP_PX / viewport.zoom);
    app.selection = hit?.itemId ?? null;
    // Draggable = has a transform (x/y) OR a moveBy hook (arrow shaft drag
    // translates its endpoints — manifest round 5: "Both must work").
    if (!hit || !(hit.plugin.capabilities.transform || hit.plugin.moveBy)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = {
      kind: "move",
      itemId: hit.itemId,
      plugin: hit.plugin,
      // moveBy needs the RAW stored state: equation-bound coordinates must be
      // recognized (strings) so they stay anchored instead of translating.
      rawItem: app.rawState().items?.[hit.itemId],
      startWorld: w,
      startX: hit.state.x ?? 0,
      startY: hit.state.y ?? 0,
      axis: null,
    };
    app.dragging = true;
  }

  function onPointerMove(e) {
    // Store ONLY the raw screen-space position (PanZoom render-area frame); the
    // ruler markers/readout are $derived from it + the view (see screenMouse).
    screenMouse = screenPoint(e);
    const w = worldPoint(e);
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
    if (drag.kind === "move") moveDrag(e, w);
    else if (drag.kind === "resize") resizeDrag(w);
    else if (drag.kind === "endpoint") endpointDrag(w);
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
      // drag origin (clipped to the viewport at render time).
      drag.axis = axisLock(dx, dy, drag.axis);
      if (drag.axis === "x") dy = 0;
      else dx = 0;
      const origin = custom ? drag.startWorld : { x: drag.startX, y: drag.startY };
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
    if (custom) {
      // Plugin-defined translation (arrow shaft): only FREE (numeric)
      // coordinates move; equation-bound ones stay anchored (see arrow.js).
      const pairs = drag.plugin.moveBy(drag.rawItem, dx, dy);
      if (pairs.length) app.setPreview(pairs.map(([p, v]) => [["items", drag.itemId, ...p], v]));
      return;
    }
    // Body-dragging writes plain numeric keyframes: direct manipulation
    // replaces an equation on x/y outright (only ENDPOINT drags have the
    // bind/detach threshold semantics — see endpointDrag).
    app.setPreview([
      [["items", drag.itemId, "x"], drag.startX + dx],
      [["items", drag.itemId, "y"], drag.startY + dy],
    ]);
  }

  // ── Resize ──────────────────────────────────────────────────────────────────

  function startResize(handleId, e) {
    const node = app.selectedNode();
    if (!node) return;
    e.stopPropagation();
    overlayEl.setPointerCapture(e.pointerId);
    const h = handleId;
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
    };
    app.dragging = true;
  }

  function resizeDrag(w) {
    const s = drag.startState;
    const local = T.apply(T.invert(drag.world), w.x, w.y); // pointer in the item's local space
    const h = drag.handleId;
    let { x, y, w: ww, h: hh } = s;
    const west = h.includes("l"), east = h.includes("r"), north = h.includes("t"), south = h.includes("b");
    if (east) ww = Math.max(MIN_SIZE, local.x);
    if (south) hh = Math.max(MIN_SIZE, local.y);
    if (west) {
      const lx = Math.min(local.x, s.w - MIN_SIZE);
      ww = s.w - lx;
      const p = T.apply(drag.world, lx, 0);
      const o = T.apply(drag.world, 0, 0);
      x = s.x + (p.x - o.x);
      y = s.y + (p.y - o.y);
    }
    if (north) {
      const ly = Math.min(local.y, s.h - MIN_SIZE);
      hh = s.h - ly;
      const p = T.apply(drag.world, 0, ly);
      const o = T.apply(drag.world, 0, 0);
      x = (west ? x : s.x) + (p.x - o.x) - (west ? 0 : 0);
      y = (west ? y : s.y) + (p.y - o.y);
      if (west) {
        // Both west+north: recompute origin from the combined local corner.
        const lx = Math.min(local.x, s.w - MIN_SIZE);
        const pc = T.apply(drag.world, lx, ly);
        x = s.x + (pc.x - T.apply(drag.world, 0, 0).x);
        y = s.y + (pc.y - T.apply(drag.world, 0, 0).y);
      }
    }

    // Snapping (edge→line + size-match) operates in WORLD space on the
    // axis-aligned case only. For rotated items the box edges aren't axis
    // parallel, so we skip snapping rather than produce wrong math.
    let newGuides = [], indicators = [];
    if (!drag.rotated && app.snapEnabled) {
      const r = applyResizeSnap({ x, y, ww, hh });
      x = r.x; y = r.y; ww = r.ww; hh = r.hh;
      newGuides = r.guides;
      indicators = r.indicators;
    }
    guides = newGuides;
    sizeIndicators = indicators;

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
    // Remember whether the anchors toggle was already on: endpoint drags show
    // anchors while they want them, but the TOGGLE (not the drag) decides
    // whether binding happens — and we restore visibility on pointer-up.
    drag = { kind: "endpoint", itemId: node.itemId, which, anchorsWereVisible: app.anchorsVisible };
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
    if (app.anchorsVisible) {
      const nodes = app.nodes().filter((n) => n.itemId !== drag.itemId);
      let best = null;
      for (const n of nodes)
        for (const a of nodeAnchors(n)) {
          const d = Math.hypot(a.x - w.x, a.y - w.y);
          if (d <= tol && (!best || d < best.d)) best = { d, ref: `@${n.itemId}_${a.id}` };
        }
      if (best) xy = { x: `${best.ref}.x`, y: `${best.ref}.y` };
      else {
        // "closest" computed anchor binds only when the pointer is within the
        // SAME threshold of the perimeter point it would produce.
        const hit = pickNode(nodes, w.x, w.y);
        if (hit?.plugin.closestAnchor) {
          const local = hit.plugin.closestAnchor(hit.state, w.x, w.y, hit.world);
          const p = T.apply(hit.world, local.x, local.y);
          if (Math.hypot(p.x - w.x, p.y - w.y) <= tol)
            xy = { x: `@${hit.itemId}_closest.x`, y: `@${hit.itemId}_closest.y` };
        }
      }
    }
    app.setPreview([
      [["items", drag.itemId, drag.which, "x"], xy.x],
      [["items", drag.itemId, drag.which, "y"], xy.y],
    ]);
  }

  function onPointerLeave() {
    if (!drag) screenMouse = null; // hide ruler markers on leave
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.kind === "endpoint") app.anchorsVisible = drag.anchorsWereVisible;
    drag = null;
    guides = [];
    sizeIndicators = [];
    app.snapEngaged = false; // cleared on pointer-up (per snap-round-2 spec)
    app.dragging = false;
    app.commitPreview();
  }

  // ── Overlay geometry (screen space) ────────────────────────────────────────

  let overlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; app.selection; app.anchorsVisible; sizeIndicators;
    if (!actions || !containerEl) return { outline: null, handles: [], anchors: [], guideSegs: [], endpoints: [], sizeArrows: [] };
    const rect = containerEl.getBoundingClientRect();
    const worldRect = {
      x: (0 - viewport.panX) / viewport.zoom,
      y: (0 - viewport.panY) / viewport.zoom,
      w: rect.width / viewport.zoom,
      h: rect.height / viewport.zoom,
    };
    const nodes = app.nodes();
    const sel = nodes.find((n) => n.itemId === app.selection);

    let outline = null, handles = [], endpoints = [];
    if (sel?.plugin.capabilities.bbox) {
      const w = sel.state.w ?? 0, h = sel.state.h ?? 0;
      const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([lx, ly]) => {
        const p = T.apply(sel.world, lx, ly);
        return actions.worldToScreen(p.x, p.y);
      });
      outline = corners.map((p) => `${p.x},${p.y}`).join(" ");
      if (sel.plugin.capabilities.resizable) {
        const hs = [["tl", 0, 0], ["tm", w / 2, 0], ["tr", w, 0], ["mr", w, h / 2], ["br", w, h], ["bm", w / 2, h], ["bl", 0, h], ["ml", 0, h / 2]];
        handles = hs.map(([id, lx, ly]) => {
          const p = T.apply(sel.world, lx, ly);
          return { id, ...actions.worldToScreen(p.x, p.y) };
        });
      }
    }
    if (sel?.plugin.editPoints) {
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
      for (const p of sel.plugin.editPoints(sel, byId))
        endpoints.push({ which: p.key, ...actions.worldToScreen(p.x, p.y) });
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

    return { outline, handles, anchors, guideSegs, endpoints, sizeArrows };
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
        {#each overlay.sizeArrows as s}
          <line
            class="size-arrow"
            x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            marker-start="url(#size-arrow-start)"
            marker-end="url(#size-arrow-end)"
          />
        {/each}
        {#if overlay.outline}
          <polygon class="selection" points={overlay.outline} />
        {/if}
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
