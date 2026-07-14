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
  import { solveSnap, axisLock } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  import { paintScene } from "../render/compositor.js";
  import * as T from "../core/transform.js";

  let { app } = $props();

  const SNAP_TOL_PX = 8; // screen px within which features snap (PENDING USER RATIFICATION)
  const ANCHOR_BIND_PX = 12; // screen px within which an arrow endpoint binds (PENDING USER RATIFICATION)
  const MIN_SIZE = 0; // sizes are non-negative — a mathematical bound, not a design choice

  const THUMB_W = 256; // minimap thumbnail render width (px)

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
  let drag = null; // non-reactive drag bookkeeping

  // Repaint whenever anything visible changes.
  $effect(() => {
    app.doc; app.slideIndex; app.previewDelta; app.anchorsVisible; viewport;
    paint();
  });

  // Minimap thumbnail: the same compositor, rendered small. Skipped while
  // dragging (previewDelta churn) — refreshed on commit.
  $effect(() => {
    app.doc; app.slideIndex; app.minimapVisible;
    if (!app.minimapVisible || app.previewDelta) return;
    const meta = app.doc.meta;
    const thumb = document.createElement("canvas");
    thumb.width = THUMB_W;
    thumb.height = Math.round((THUMB_W * meta.slideH) / meta.slideW);
    const view = { zoom: THUMB_W / meta.slideW, panX: 0, panY: 0, dpr: 1 };
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
    const dpr = window.devicePixelRatio || 1;
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
    });
  }

  // PanZoom → our state (also parks actions on the app for commands like Reset View).
  function onviewport(vp) {
    viewport = vp;
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
    const hit = pickNode(nodes, w.x, w.y);
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
    if (!drag) return;
    const w = worldPoint(e);
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
      const nodes = app.nodes();
      const me = nodes.find((n) => n.itemId === drag.itemId);
      if (me) {
        const shifted = {
          ...me,
          world: { ...me.world, x: drag.startX + dx, y: drag.startY + dy },
          state: { ...me.state, x: drag.startX + dx, y: drag.startY + dy },
        };
        const probes = nodeFeatures(shifted).filter((f) => f.kind === "point");
        const features = nodes.filter((n) => n.itemId !== drag.itemId).flatMap(nodeFeatures);
        const tol = SNAP_TOL_PX / viewport.zoom;
        const snap = solveSnap(probes, features, tol);
        dx += snap.dx;
        dy += snap.dy;
        newGuides.push(...snap.guides);
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
    drag = {
      kind: "resize",
      itemId: node.itemId,
      handleId,
      startState: { x: node.state.x, y: node.state.y, w: node.state.w, h: node.state.h },
      world: node.world,
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
    app.setPreview([
      [["items", drag.itemId, "x"], x],
      [["items", drag.itemId, "y"], y],
      [["items", drag.itemId, "w"], ww],
      [["items", drag.itemId, "h"], hh],
    ]);
  }

  // ── Arrow endpoint drag (anchor binding UX) ────────────────────────────────

  function startEndpoint(which, e) {
    const node = app.selectedNode();
    if (!node) return;
    e.stopPropagation();
    containerEl.querySelector("svg").setPointerCapture(e.pointerId);
    drag = { kind: "endpoint", itemId: node.itemId, which };
    app.dragging = true;
    app.anchorsVisible = true; // anchors appear as X's while an endpoint wants them
  }

  function endpointDrag(w) {
    const tol = ANCHOR_BIND_PX / viewport.zoom;
    const nodes = app.nodes().filter((n) => n.itemId !== drag.itemId);
    let binding = { x: w.x, y: w.y };
    // Nearest anchor X within tolerance binds a preset anchor…
    let best = null;
    for (const n of nodes)
      for (const a of nodeAnchors(n)) {
        const d = Math.hypot(a.x - w.x, a.y - w.y);
        if (d <= tol && (!best || d < best.d)) best = { d, binding: { item: n.itemId, anchor: a.id } };
      }
    if (best) binding = best.binding;
    // …otherwise dropping on a widget's body binds its computed "closest" anchor.
    else {
      const hit = pickNode(nodes, w.x, w.y);
      if (hit?.plugin.closestAnchor) binding = { item: hit.itemId, anchor: "closest" };
    }
    app.setPreview([[["items", drag.itemId, drag.which], binding]]);
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.kind === "endpoint") app.anchorsVisible = false;
    drag = null;
    guides = [];
    app.dragging = false;
    app.commitPreview();
  }

  // ── Overlay geometry (screen space) ────────────────────────────────────────

  let overlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; app.selection; app.anchorsVisible;
    if (!actions || !containerEl) return { outline: null, handles: [], anchors: [], guideSegs: [], endpoints: [] };
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

    return { outline, handles, anchors, guideSegs, endpoints };
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
        {#each overlay.guideSegs as g}
          {#if g.kind === "line"}
            <line class="guide" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
          {:else}
            <circle class="guide-point" cx={g.x} cy={g.y} r="4" />
          {/if}
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
