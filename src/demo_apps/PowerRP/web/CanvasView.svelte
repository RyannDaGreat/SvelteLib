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
  import { pickNode, nodeFeatures, nodeAnchors } from "../core/derive.js";
  import { solveSnap, solveEdgeSnap, sizeMatches, axisLock } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  import { paintScene, THUMB_W } from "../render/compositor.js";
  import * as T from "../core/transform.js";

  let { app } = $props();

      const SNAP_PX = 8; // THE one uniform snap threshold (user rule): drag snap, resize snap, anchor bind, border grab (value PENDING USER RATIFICATION)
  const MIN_SIZE = 0; // sizes are non-negative — a mathematical bound, not a design choice

  let containerEl = $state(null);
  let canvasEl = $state(null);
  let wrapW = $state(0);
  let wrapH = $state(0);
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
  let hoverItemId = $state(null); // item under the pointer (hover-only chrome)
  // Anchor under the pointer → immediate SVG-native tooltip naming it
  // (HTML Tooltip can't nest inside <svg>). {label, x, y} in world coords.
  let hoverAnchor = $state(null);
  let drag = null; // non-reactive drag bookkeeping

  // Repaint whenever anything visible changes — INCLUDING the container size
  // (wrapW/wrapH), so pane resizes re-render instead of stretching the bitmap.
  $effect(() => {
    app.doc; app.slideIndex; app.previewDelta; app.anchorsVisible; viewport; wrapW; wrapH;
    app.selection; hoverItemId; app.theme; // hover/selected chrome + theme color
    paint();
  });

  // Minimap thumbnail: the same compositor, rendered small. Skipped while
  // dragging (previewDelta churn) — refreshed on commit.
  $effect(() => {
    app.doc; app.slideIndex; app.minimapVisible;
    if (!app.minimapVisible || app.previewDelta) return;
    const meta = app.doc.meta;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const cssH = Math.round((THUMB_W * meta.slideH) / meta.slideW);
    const thumb = document.createElement("canvas");
    thumb.width = Math.round(THUMB_W * dpr);
    thumb.height = Math.round(cssH * dpr);
    const view = { zoom: THUMB_W / meta.slideW, panX: 0, panY: 0, dpr };
    paintScene(thumb.getContext("2d"), app.doc, {
      slideIndex: app.slideIndex,
      alpha: 1,
      registry: app.registry,
      view,
    });
    minimapThumb = thumb.toDataURL("image/png");
  });

  function paint() {
    if (!canvasEl || !containerEl) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const rect = containerEl.getBoundingClientRect();
    if (canvasEl.width !== Math.round(rect.width * dpr) || canvasEl.height !== Math.round(rect.height * dpr)) {
      canvasEl.width = Math.round(rect.width * dpr);
      canvasEl.height = Math.round(rect.height * dpr);
    }
    const ctx = canvasEl.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    paintScene(ctx, app.doc, {
      slideIndex: app.slideIndex,
      alpha: 1,
      registry: app.registry,
      view: { ...viewport, dpr },
      anchorsVisible: app.anchorsVisible,
      stateOverride: app.previewDelta,
      editorChrome: true, // camera bbox etc. draw only here
      hoveredId: hoverItemId,
      selectedId: app.selection,
      // Editor chrome color comes from the THEME (user rule — no hardcoded cyan).
      chromeColor: getComputedStyle(containerEl).getPropertyValue("--a-selection").trim() || null,
    });
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

  function worldPoint(e) {
    const rect = containerEl.getBoundingClientRect();
    return actions.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  // ── Selection + drag ────────────────────────────────────────────────────────

  function onPointerDown(e) {
    if (e.button !== 0 || app.mode !== "edit") return;
    const w = worldPoint(e);
    const nodes = app.nodes();
    const hit = pickNode(nodes, w.x, w.y, SNAP_PX / viewport.zoom);
    app.selection = hit?.itemId ?? null;
    if (!hit || !hit.plugin.capabilities.transform) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag = {
      kind: "move",
      itemId: hit.itemId,
      startWorld: w,
      startX: hit.state.x ?? 0,
      startY: hit.state.y ?? 0,
      axis: null,
    };
    app.dragging = true;
  }

  function onPointerMove(e) {
    const w = worldPoint(e);
    if (!drag) {
      // Hover tracking for hover-only chrome (the camera's border).
      const nodes = app.nodes();
      hoverItemId = pickNode(nodes, w.x, w.y, SNAP_PX / viewport.zoom)?.itemId ?? null;
      // Anchor hover tooltip (immediate; only while anchors are shown).
      hoverAnchor = null;
      if (app.anchorsVisible) {
        const tol = SNAP_PX / viewport.zoom;
        let best = null;
        for (const n of nodes)
          for (const a of nodeAnchors(n)) {
            const d = Math.hypot(a.x - w.x, a.y - w.y);
            if (d <= tol && (!best || d < best.d))
              best = { d, label: `${app.displayName(n.itemId)} · ${a.id}`, x: a.x, y: a.y };
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
    if (e.shiftKey) {
      // Axis lock with hysteresis; guide is an INFINITE line through the
      // drag origin (clipped to the viewport at render time).
      drag.axis = axisLock(dx, dy, drag.axis);
      if (drag.axis === "x") dy = 0;
      else dx = 0;
      newGuides.push({
        kind: "line",
        x: drag.startX, y: drag.startY,
        dx: drag.axis === "x" ? 1 : 0, dy: drag.axis === "x" ? 0 : 1,
      });
    } else {
      drag.axis = null;
      // Snap: probe with the dragged item's own point features at the
      // proposed position; snap against every OTHER node's features.
      // Gated on app.snapEnabled (master toggle — off = no snapping anywhere).
      const nodes = app.nodes();
      const me = nodes.find((n) => n.itemId === drag.itemId);
      if (app.snapEnabled && me) {
        const shifted = {
          ...me,
          world: { ...me.world, x: drag.startX + dx, y: drag.startY + dy },
          state: { ...me.state, x: drag.startX + dx, y: drag.startY + dy },
        };
        const probes = nodeFeatures(shifted).filter((f) => f.kind === "point");
        const features = nodes.filter((n) => n.itemId !== drag.itemId).flatMap(nodeFeatures);
        const tol = SNAP_PX / viewport.zoom;
        const snap = solveSnap(probes, features, tol);
        dx += snap.dx;
        dy += snap.dy;
        newGuides.push(...snap.guides);
        if (snap.dx !== 0 || snap.dy !== 0) app.snapEngaged = true;
      }
    }
    guides = newGuides;
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
    containerEl.querySelector("svg").setPointerCapture(e.pointerId);
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
    containerEl.querySelector("svg").setPointerCapture(e.pointerId);
    // Remember whether the anchors toggle was already on: endpoint drags show
    // anchors while they want them, but the TOGGLE (not the drag) decides
    // whether binding happens — and we restore visibility on pointer-up.
    drag = { kind: "endpoint", itemId: node.itemId, which, anchorsWereVisible: app.anchorsVisible };
    app.dragging = true;
  }

  function endpointDrag(w) {
    const tol = SNAP_PX / viewport.zoom;
    // Anchor binding is GATED on the anchors toggle, and only ever happens
    // within the ONE uniform snap threshold — dragging past it DISCONNECTS
    // (user rule; the old drop-anywhere-on-body "closest" rebinding was
    // sticky and obnoxious).
    let binding = { x: w.x, y: w.y };
    if (app.anchorsVisible) {
      const nodes = app.nodes().filter((n) => n.itemId !== drag.itemId);
      let best = null;
      for (const n of nodes)
        for (const a of nodeAnchors(n)) {
          const d = Math.hypot(a.x - w.x, a.y - w.y);
          if (d <= tol && (!best || d < best.d)) best = { d, binding: { item: n.itemId, anchor: a.id } };
        }
      if (best) binding = best.binding;
      else {
        // "closest" computed anchor binds only when the pointer is within the
        // SAME threshold of the perimeter point it would produce.
        const hit = pickNode(nodes, w.x, w.y);
        if (hit?.plugin.closestAnchor) {
          const local = hit.plugin.closestAnchor(hit.state, w.x, w.y, hit.world);
          const p = T.apply(hit.world, local.x, local.y);
          if (Math.hypot(p.x - w.x, p.y - w.y) <= tol) binding = { item: hit.itemId, anchor: "closest" };
        }
      }
    }
    app.setPreview([[["items", drag.itemId, drag.which], binding]]);
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

<div class="canvas-wrap" bind:this={containerEl} bind:clientWidth={wrapW} bind:clientHeight={wrapH}>
  <PanZoom {onviewport}>
    {#snippet children(vp, a)}
      {bindActions(a)}
      <canvas bind:this={canvasEl} class="scene"></canvas>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        class="overlay"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
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

<!-- Styling lives in app.css (app convention: no <style> blocks in app components). -->
