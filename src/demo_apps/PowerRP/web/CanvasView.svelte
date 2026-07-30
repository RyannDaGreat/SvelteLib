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
  import VideoV7Overlay from "./VideoV7Overlay.svelte"; // per-widget WebGPU video canvases stacked over the Skia scene (video_v7)
  import { videoV7Descriptors } from "./videoV7Placement.js";
  import { pickNode, pointInNodeBox, nodeFeatures, nodeAnchors, nodeModifierPoints, modifierWrite, isGhostNode, deriveRenderTree, cameraRect, worldTransform, stateXYForCenterPivotWorld, groupMembership, snapExclusionSet } from "../core/derive.js";
  import { solveSnap, solveEdgeSnap, sizeMatches, axisLock, provenanceAnchorId, anchorSnapEquation, resizeEdgeEquation } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  import { worldViewRect, canSkipNode } from "../core/view.js";
  import { ESC_CANCELABLE_DRAG_KINDS } from "../core/shortcut_entries.js";
  // dedupeGroupSelection: the group invariant app.selectMany enforces at commit —
  // imported here so the LIVE band preview shows the same set the commit will
  // keep (see bandSelectionAt), never a superset the commit then filters.
  import { selectInBox, rectFromCorners, dedupeGroupSelection } from "../core/bandselect.js";
  import { sceneIR, resolvedBackgroundFill } from "../render_gpu/ports.js";
  import { preRasterizePdfPages } from "../render_gpu/pdf_display.js";
  import { rect as rectCmd } from "../render_gpu/ir.js";
  import { SkiaSurface } from "../render_gpu/skia/browser_surface.js";
  import { cameraDither } from "../render_gpu/skia/dither_shader.js";
  import { cameraAntialias, antialiasCoverage } from "../render_gpu/skia/render_settings.js";
  import { onImageLoad } from "../render_gpu/gpu/image_registry.js";
  import { onSvgSourceLoad } from "../render_gpu/gpu/svg_source_registry.js";
  import { onVideoFrame, setActiveVideoRefs } from "../render_gpu/gpu/video_registry.js";
  import { onVideoV5Frame, setActiveVideoV5Refs } from "../render_gpu/skia/video_v5.js"; // V5 off-main-thread video: same wake+gate contract as the core video path
  // Video V8 (cohort) — a FRESH, independent overlay player: ONE canvas stacked
  // over the Skia scene, WebGPU zero-copy OR WebGL2 upload backend. Its registry
  // is separate from the stock video path above (no reuse), so the two never
  // fight over elements. Wiring below mirrors the stock path's cull/gate/nudge.
  import { createVideoV8Overlay, videoV8SourcesOf } from "./videoV8Overlay.js";
  import { onVideoV8Frame, setActiveVideoV8Refs } from "./videoV8Registry.js";
  import { renderCameraFrame } from "./gpuService.js";
  // thumbRenderPaused: THE shared "a gesture is in flight, hold offscreen renders"
  // predicate (web/thumbSchedule.js) — the minimap gates on the same one SlideNav's
  // thumbnails do, so there is one rule for "don't raster during a gesture".
  import { thumbRenderPaused } from "./thumbSchedule.js";
  import { cameraRectAt } from "./cameraFrame.js";
  import * as T from "../core/transform.js";
  // Extracted pure drag geometry (manifest UNDEFERRAL SWEEP: CanvasView
  // drag-machine extraction — PARTIAL: the stateless math; the stateful per-kind
  // handlers stay here). See web/canvas/dragKinds.js + tests/dragkinds_test.js.
  import { translationPairs, resizeAnchors, resizedBox, scaleMemberPairs, scalePairs, groupResizeState, creationRect, creationEndpoint, itemGeometryPairs } from "./canvas/dragKinds.js";
  import { diffState } from "../core/deltas.js";
  import { visibleLevels, ticksInRange } from "../../../lib/ticks.js";
  import { ASSET_DRAG_MIME, isProjectZip } from "./projectApi.js"; // asset-tile drop payload type + the one .zip-is-a-project rule (drop-handler region)
  import { reportAction } from "../core/report.js"; // a refused DROP is one user act — reportAction, never the deduped reportOnce
  import TextEditController from "./TextEditController.svelte"; // TRUE in-place rich-text editor (Skia-owned caret/selection)
  import LatexEditController from "./LatexEditController.svelte"; // WYSIWYG LaTeX editor (MathLive DOM overlay + canvas suppression)
  import "./latexEditor.js"; // PRE-WARM MathLive at app boot (register <math-field> + load offline fonts) so first edit isn't janky
  import CodeEditController from "./CodeEditController.svelte"; // multi-line CODE editor overlay (reusable code-string editor; no widget binds it by default)
  import BentoTargetList from "./BentoTargetList.svelte"; // a canvas mode's LIST of pickable widgets (the second input path for a bento cell bind)
  import CanvasToolbar from "./CanvasToolbar.svelte"; // GENERAL floating canvas toolbar (double-click a widget that declares floatingToolbar); mounted as a canvas overlay
  import HandleToolbar from "./HandleToolbar.svelte"; // the SELECTED-HANDLE tools, on the shared FloatingCanvasPanel shell
  import ContextMenu from "./ContextMenu.svelte"; // the on-canvas point menu (F.18)
  import VideoV6Overlay from "./VideoV6Overlay.svelte"; // ONE shared WebGPU external-texture canvas over the scene; draws live V6 video frames (WebGL2 upload fallback on plain HTTP)
  import { copyText } from "./clipboard.js"; // HTTP-safe clipboard write (anchor-copy affordance, below)
  // THE WIDGET UI-HANDLER REGISTRY: what CREATION and DOUBLE-CLICK do is declared
  // by each widget and implemented in web/widget_handlers.js, so neither dispatch
  // below carries per-type branches (and a NEW kind of either needs no edit here).
  import { findHandler, getHandler, handlerFor } from "./widget_handlers.js";
  import { ZOOM_GESTURE_IDLE_MS } from "./interiorNav.js";
  // The step-sequencing half of the create phase (multi-gesture placements: a
  // polygon's click-click-click, the telescopic rig's two boxes). One pointer
  // payload for every hook, so the host never shapes it per handler.
  import { creationPointer, currentStepIndex } from "./creationSteps.js";

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
  // The itemId whose FLOATING TOOLBAR is open (opened by double-clicking a
  // widget that declares floatingToolbar; closed on any canvas pointerdown or
  // when the selection moves off it). Local to CanvasView — the overlay is a
  // pure canvas-editor affordance, not app/document state.
  let floatingToolbarItemId = $state(null);

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
  /**
   * THE MODE CURSOR CLASS — "" or `cursor-<name>`, where <name> is the live canvas
   * mode's cursor for the CURRENT STEP (clamped like a step index, so a mode may
   * declare fewer cursors than steps). A mode this modal must say so under the
   * pointer, and its two steps ask different questions.
   *
   * STATE → CLASS, styling in web/app.css — the crosshair `skin` precedent, and the
   * reason there is no inline style here. Because it is DERIVED from app.canvasMode,
   * every exit route (Escape, a slide switch, entering the presenter, finalize's
   * selection write) reverts it by construction: no imperative cursor state exists
   * that could get stuck. web/widget_handlers.canvasModes() validates each declared
   * name against the rules app.css actually ships, at boot, so a typo is loud rather
   * than a mode with no cursor.
   */
  let modeCursorClass = $derived.by(() => {
    const cursors = app.canvasMode ? findHandler(app.canvasMode.handlerId).mode?.cursors : null;
    if (!cursors) return "";
    return `cursor-${cursors[Math.min(app.canvasMode.step, cursors.length - 1)]}`;
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
  // Per-widget WebGPU video overlay descriptors (video_v7), rebuilt each paint
  // from the POST-cull node set so off-view clips are dropped (→ paused).
  let videoV7Descs = $state([]);
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
  // (HTML Tooltip can't nest inside <svg>). {label, x, y} in world coords; the
  // NON-drag hover path also carries {itemId, anchorId} so the copy affordance
  // (below) can build the anchor's equation reference. During an ENDPOINT drag
  // this is the live bind candidate (manifest Anchor UX: the nearest bindable
  // anchor shows its referencable name mid-drag) and carries no itemId/anchorId.
  let hoverAnchor = $state(null);
  // ── ANCHOR COPY DISCOVERABILITY (task #41) ─────────────────────────────────
  // Hovering an anchor reveals two small copy chips (.x / .y); clicking one
  // copies that anchor's VALID equation reference — the DISPLAY form
  // "<itemSlug>_<anchorId>.x|y" (exactly what displayToStored rewrites to the
  // stored "@<itemId>_<anchorId>.x|y" the evaluator resolves; the SAME grammar
  // the Inspector's copy-equation-path affordance uses), so it can be pasted
  // straight into any equation field. HYSTERESIS (below, in onPointerMove) keeps
  // the tip alive within HOVER_KEEP_PX so the pointer can travel off the anchor
  // onto the chips without dismissing it. Mirrors the Inspector's "Copied!" flash.
  const HOVER_KEEP_PX = 72; // screen-px keep radius (> the SNAP_PX acquire zone); covers the chip footprint so travel-to-chip never dismisses the tip
  const COPY_FLASH_MS = 1200; // how long a chip flashes its "copied" check (matches Inspector/AssetExplorer)
  const ANCHOR_COPY_TIP_X = 10; // x offset of the tip from the anchor (matches the existing name-label x)
  const ANCHOR_COPY_LABEL_Y = 13; // baseline of the anchor-name label
  const ANCHOR_COPY_CHIP_Y = 18; // top of the chip row (below the label)
  const ANCHOR_COPY_CHIP_W = 24; // one chip's width
  const ANCHOR_COPY_CHIP_H = 16; // one chip's height
  const ANCHOR_COPY_CHIP_GAP = 4; // gap between the .x and .y chips
  // {itemId, anchorId, coord} of the chip currently flashing its "copied" check,
  // or null. Identity-checked so a stale timeout never clears a newer flash.
  let justCopiedAnchor = $state(null);
  // Computed ("dynamic") anchor candidate during an endpoint drag — a point
  // that is a live FUNCTION (the closest-point-on-perimeter tracking the
  // dragged endpoint), not a fixed preset: rendered as a # glyph, vs the
  // preset anchors' X. {x, y} world coords, or null.
  let dynamicAnchor = $state(null);
  // ── BAND-SELECT MODIFIERS (add / subtract / invert) ────────────────────────
  /**
   * THE BAND-SELECT MODIFIER TABLE — the SINGLE place the held-modifier →
   * selection-verb assignment lives. Every other line of band code asks for the
   * VERB (bandVerb) and never reads a key flag, so re-assigning a modifier is a
   * one-line edit here. ORDERED: the first held modifier wins, so this order IS
   * the precedence for combinations (Alt+Shift = invert, because "alt" is
   * listed first). `mod` is the platform-agnostic command/control modifier —
   * the file's existing `e.metaKey || e.ctrlKey` idiom (placementDrag /
   * resizeDrag's `symmetric`), never one platform's key.
   *
   * WHY THIS ASSIGNMENT — do not "fix" SHIFT to mean ADD:
   *   SHIFT = SUBTRACT is a REQUIREMENT, not a convention guess. The manifest
   *   ("Box select round 2") says verbatim "SHIFT during box select = DESELECT
   *   the enclosed/touched items"; it is what this drag has done since
   *   box-select round 2 (0675c81); and the user restated it while asking for
   *   this feature ("shift will mean remove from selection"). It does NOT
   *   contradict shift-CLICK, which TOGGLES membership
   *   (app.toggleInSelection) — shift-clicking an already-selected item REMOVES
   *   it, so "Shift takes things OUT of the selection" is the same story in
   *   both gestures.
   *   MOD = ADD and ALT = INVERT are likewise the user's own words ("holding
   *   command will mean add to selection ... maybe alt will mean invert
   *   selection").
   */
  const BAND_MODIFIER_VERBS = [
    { held: "alt", verb: "invert" },
    { held: "shift", verb: "subtract" },
    { held: "mod", verb: "add" },
  ];
  /** The verb of a band drag with NO modifier held: the caught set BECOMES the
   * selection (whatever was selected outside the box drops out) — the
   * pre-existing plain-band behavior, unchanged. */
  const BAND_VERB_UNMODIFIED = "replace";
  /** No modifier held — the band record's rest state (init + window blur). */
  const NO_MODIFIERS = { shift: false, alt: false, mod: false };
  // Screen-px radius of a LANDED-VERTEX marker in a multi-step creation preview.
  // LINKED to the .guide-point / snap-guide dot radius this same overlay already
  // draws (r="4") — one dot size for the editor's transient point markers, so a
  // polygon's vertices read at the same weight as a snap point rather than
  // introducing a second scale of decoration.
  const PLACE_DOT_R = 4;

  // In-progress rubber-band selection (armed via the palette "Select in Box"
  // commands / the B key / the toolbar button, or started directly by an
  // empty-space drag): the world-space band rect plus the TWO PREVIEW BUCKETS —
  // the itemIds a release right now would ADD to the selection and the ones it
  // would REMOVE from it. Both buckets are a DIFF of the current selection
  // against the verb's outcome (refreshBandPreview), so the preview states the
  // pending CHANGE, not just "what is in the box" — a subtract band can then
  // look different from an add band. All three cleared on pointer-up.
  let bandRect = $state(null); // {x, y, w, h} world, or null
  let bandAddIds = $state([]); // itemIds a release would ADD to the selection
  let bandRemoveIds = $state([]); // itemIds a release would REMOVE from the selection
  // The modifiers held RIGHT NOW for the live band drag — the verb the release
  // will apply (BAND_MODIFIER_VERBS). $state, not plain bookkeeping like
  // `aHeld`, because the preview repaints from it: pressing Alt with the pointer
  // standing still must re-color the preview. Fed from three places (the
  // pointer-down event, every pointer move, and window key events while a band
  // drag is live) through the one `modifiersOf` reader.
  let bandMods = $state(NO_MODIFIERS);
  // In-progress CROSSHAIR PLACEMENT preview (manifest ARCHITECTURE PLAN #5):
  // the world-space rect a drag-placement is about to create. Null outside a
  // placement drag (a plain click never sets it — see placementUp).
  let placeRect = $state(null); // {x, y, w, h} world, or null
  // In-progress ENDPOINT-placement preview (arrow-family Add buttons, manifest
  // UNDEFERRAL SWEEP): the world-space from→to segment a drag-placement is about
  // to create. Null outside an endpoint placement drag (and for bbox placements,
  // which use placeRect instead).
  let placeLine = $state(null); // {x1, y1, x2, y2} world, or null
  // In-progress MULTI-STEP creation preview (web/creationSteps.js): whatever the
  // live creation mode's `overlay(session)` returns, in WORLD units —
  // {chains, rects, dots}. The generalization of placeRect/placeLine to a
  // placement that accumulates: a polygon needs a CHAIN (placeLine covers one
  // segment) plus a dot per landed vertex; the telescopic rig needs the first box
  // to stay drawn while the second is dragged. Null outside a creation mode.
  let placePreview = $state(null);
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
  // URL-sourced SVG text loads are the same async-arrival shape (an svg widget
  // in url mode draws nothing until its source lands) — same epoch, same nudge.
  $effect(() => onSvgSourceLoad(() => (imageEpoch += 1)));
  // Playing videos repaint per decoded frame (requestVideoFrameCallback via
  // the registry) — same epoch, same reason (reactive paint, async frames). BUT
  // ONLY for a video the CURRENT frame actually draws: the video registry is
  // shared, so thumbnails (SlideNav) spawn a playing <video> for EVERY video on
  // EVERY slide, and each would otherwise pump this epoch and repaint the editor
  // at the videos' combined framerate even when the current slide has none (the
  // reported 120→~16-30 fps drop). `currentMediaRefs` (rebuilt each paint from
  // the on-screen scene's video/scrubber sources) gates the wake to on-screen
  // media only; off-slide/off-screen frames are ignored.
  let currentMediaRefs = new Set(); // non-reactive: the last paint's on-screen video sources
  $effect(() => onVideoFrame((src) => { if (currentMediaRefs.has(src)) imageEpoch += 1; }));
  // V5 off-main-thread video: its own registry pumps a distinct frame nudge; wake
  // the reactive paint on a NEW frame of an on-screen V5 clip (same gate as above,
  // currentMediaRefs includes "video_v5" sources below).
  $effect(() => onVideoV5Frame((src) => { if (currentMediaRefs.has(src)) imageEpoch += 1; }));
  // VIDEO V8 OVERLAY (cohort): its own stacked canvas + backend, created async
  // (WebGPU device selection is async) once the element binds. Playing V8 frames
  // nudge the SAME imageEpoch (reactive paint, async frames) — but only for a src
  // the current frame actually draws (currentV8Refs), so off-screen/off-slide
  // frames never wake the editor. Init failure is LOUD and user-visible.
  let videoV8El = $state(null);
  let videoV8 = $state(null);
  let videoV8Error = $state(null);
  let currentV8Refs = new Set(); // non-reactive: last paint's on-screen V8 video sources
  $effect(() => {
    if (!videoV8El || videoV8 || videoV8Error) return;
    createVideoV8Overlay(videoV8El)
      .then((o) => (videoV8 = o))
      .catch((e) => {
        videoV8Error = String(e?.message ?? e);
        console.error("PowerRP: Video V8 overlay init failed:", e);
      });
  });
  onDestroy(() => videoV8?.dispose());
  $effect(() => onVideoV8Frame((src) => { if (currentV8Refs.has(src)) imageEpoch += 1; }));
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

  // VIDEO V6 (fresh WebGPU external-texture overlay): the POST-CULL visible
  // video_v6 nodes + the current view + the scene canvas's device size, handed to
  // VideoV6Overlay (a separate canvas stacked over the scene). Assigned in paint();
  // the overlay draws live frames on its OWN requestVideoFrameCallback loop, so
  // playback never re-runs this Skia paint (zero scene cost per video frame).
  let videoV6Nodes = $state([]);
  let videoV6View = $state(null);
  let videoV6Device = $state({ w: 0, h: 0 });

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
    // `antialias` sets the WebGL2 context's MSAA flag from THE camera's
    // Anti-aliasing setting AT CREATION (read once here). This is the coarse,
    // creation-time knob; the LIVE per-frame control is the coverage-AA flag
    // threaded through paint() below, which needs no surface recreation. (A
    // camera flip does not recreate the surface — out of scope; the coverage
    // path is the live control the user sees.)
    SkiaSurface.create(canvasEl, { antialias: antialiasCoverage(cameraAntialias(app.state())) })
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
    app.doc; app.slideIndex; app.previewDelta; app.anchorsVisible; app.latexEditing; app.codeEditing; viewport; wrapW; wrapH; gpu; imageEpoch; videoV8;
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
  // The minimap is a ~150px OVERVIEW — it does NOT need per-video-frame updates.
  // Driving it off the raw `imageEpoch` (≈30/s while a clip plays) re-ran the whole
  // offscreen slide render + full-res video CPU readback + PNG encode 30×/s on the
  // main thread (the leftover "sluggish with a video" cost). So decouple it: EDITS
  // refresh immediately (the effect's app.doc/slideIndex/minimapCamRect deps), while
  // playing video refreshes it at most MINIMAP_REFRESH_MS apart via a trailing
  // throttle of `imageEpoch` into `minimapVideoTick`.
  const MINIMAP_REFRESH_MS = 125; // ≤ 8 fps — an overview cadence, never video-rate
  let minimapVideoTick = $state(0);
  let minimapLastTick = 0;   // performance.now() of the last emitted tick (non-reactive)
  let minimapTimer = null;   // pending trailing-edge timer, or null (non-reactive)
  $effect(() => {
    imageEpoch; // the raw per-on-screen-video-frame epoch (≈30/s while playing)
    if (!app.minimapVisible) return; // hidden → schedule no offscreen work
    const now = performance.now();
    const since = now - minimapLastTick;
    if (since >= MINIMAP_REFRESH_MS) { minimapLastTick = now; minimapVideoTick += 1; } // leading edge
    else if (minimapTimer === null) { // one trailing tick catches the burst's last frame
      minimapTimer = setTimeout(() => { minimapTimer = null; minimapLastTick = performance.now(); minimapVideoTick += 1; }, MINIMAP_REFRESH_MS - since);
    }
  });
  onDestroy(() => { if (minimapTimer !== null) clearTimeout(minimapTimer); });
  // SETTLE before rendering the minimap = SlideNav's THUMB_SETTLE_MS (the same
  // "wait for quiet, then render the final state ONCE" job; linked, not invented).
  const MINIMAP_SETTLE_MS = 120;
  $effect(() => {
    // minimapVideoTick (throttled), NOT the raw imageEpoch — see the throttle above.
    app.doc; app.slideIndex; app.minimapVisible; minimapCamRect; minimapVideoTick;
    // GATE — thumbRenderPaused, the SAME predicate SlideNav's thumbnails gate on
    // (web/thumbSchedule.js), instead of the previewDelta-only test this used to
    // do. It takes BOTH `dragging` and `previewDelta`, which matters here
    // specifically: previewDelta alone misses the pointer-down→first-move window
    // AND every preview-less gesture — band select and crosshair placement stage
    // no preview at all, so they were never gated before.
    if (!app.minimapVisible || thumbRenderPaused(app)) return;
    const rect = minimapCamRect;
    if (!(rect.w > 0 && rect.h > 0)) return; // degenerate camera → no thumbnail
    const dpr = app.dpr(); // retina browser setting (manifest)
    // Fit the camera-rect aspect into a MINIMAP_MAX_PX box (the displayed size),
    // then × dpr so it is exactly as crisp as the screen shows it.
    const scale = MINIMAP_MAX_PX / Math.max(rect.w, rect.h);
    const width = Math.max(1, Math.round(rect.w * scale * dpr));
    const height = Math.max(1, Math.round(rect.h * scale * dpr));
    // DEFERRAL — the gate alone is not enough. Un-gating happens ON POINTER-UP,
    // inside the very task that commits the edit and queues the viewport repaint,
    // so a synchronous render here put a GPU→CPU readback directly BEHIND that
    // repaint on the shared raster device and then WAITED on the queue: a 150×90
    // readback measured 67 ms on a material-heavy deck (84× its ~0.8 ms at-rest
    // cost) — queue-wait, not pixels. Handing it to a timer moves the readback out
    // of the triggering task so the repaint drains first. The effect's own cleanup
    // clears a pending timer, so a BURST of commits coalesces into one render of
    // the final state — SlideNav's publish-timer pattern. Every input the render
    // needs is captured SYNCHRONOUSLY above/here; the timer body re-reads no
    // reactive state (doing so would resubscribe this effect from a stale task).
    const doc = app.doc, slideIndex = app.slideIndex, registry = app.registry;
    const handle = setTimeout(() => {
      renderCameraFrame(doc, {
        slideIndex,
        alpha: 1,
        registry,
        width,
        height,
        // The minimap is a ~150px OVERVIEW — proxy quality (like SlideNav thumbnails),
        // NOT full. Full quality ran heavy generative materialFill shaders (lens
        // flare ~1.3s) on the CPU surface, and because this effect is gated off
        // during drag (previewDelta) it fired that render on POINTER-UP → a ~1s
        // freeze on drop (the reported lens-flare drag spike). Proxy routes it
        // through the cheap material stand-ins (drawProxyMaterialFill, ~6ms).
        quality: "proxy",
      }).then((thumb) => (minimapThumb = thumb.toDataURL("image/png")));
    }, MINIMAP_SETTLE_MS);
    return () => clearTimeout(handle);
  });

  /**
   * Pure function. The distinct non-empty video SOURCE strings among `nodes`
   * whose widget `type` is one of `types` (video player / scrubber). Both plugins
   * key their `<video>` in the registry by `state.src`, so this is exactly the set
   * of sources the registry tracks for those nodes.
   *
   * @param {Array} nodes derived render nodes ({type, state, ...})
   * @param {...string} types widget types to include ("video", "video_scrub")
   * @returns {Set<string>} distinct source strings
   * @example videoSourcesOf([{type: "video", state: {src: "a.mp4"}}, {type: "rect", state: {}}], "video") // Set {"a.mp4"}
   */
  function videoSourcesOf(nodes, ...types) {
    const set = new Set();
    for (const n of nodes) if (types.includes(n.type) && typeof n.state.src === "string" && n.state.src.length > 0) set.add(n.state.src);
    return set;
  }

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
    // LATEX EDIT SUPPRESSION (the deliberate divergence from text): while a latex
    // widget is edited, its canvas equation is DROPPED so only the MathLive DOM
    // overlay is visible (MathJax has no caret to self-draw — see
    // LatexEditController). During the `closing` crossfade the item is
    // UN-suppressed so the re-typeset render appears beneath the fading field.
    const latexSuppressId = app.latexEditing && !app.latexEditing.closing ? app.latexEditing.itemId : null;
    // CODE EDIT SUPPRESSION (same divergence as latex): while a widget's code
    // property is edited in the CodeEditController overlay, its canvas render is
    // DROPPED (the opaque editor panel covers it, and dropping it means emit()
    // never re-renders per keystroke — the async render fires ONCE on commit
    // when the item is un-suppressed during the `closing` crossfade).
    const codeSuppressId = app.codeEditing && !app.codeEditing.closing ? app.codeEditing.itemId : null;
    const allNodes = deriveRenderTree(state, app.registry);
    const nodes = allNodes
      .filter((n) => !canSkipNode(n, viewRect) && n.itemId !== latexSuppressId && n.itemId !== codeSuppressId);
    // VIDEO PLAYBACK GATE: only PLAYER videos actually VISIBLE this frame may
    // play/decode/pump. Fed the POST-cull `nodes` (not the pre-cull slide set), so
    // a clip that is off-view — off SCREEN (panned away, culled) OR on another
    // slide — is PAUSED and the browser stops decoding it ("videos should not take
    // any CPU if we're not looking at them"). el.pause()/play() PRESERVES
    // currentTime, so re-entering view RESUMES from where it left off (not a
    // restart); setActiveVideoRefs only toggles on a real paused-state change, so
    // it never thrashes per paint. Scrubbers (paused, seek-driven — not autoplay)
    // are untouched.
    setActiveVideoRefs(videoSourcesOf(nodes, "video"));
    // V5 off-main-thread video: same POST-cull playback gate as the core path —
    // an off-view V5 clip PAUSES (captureStream stops → its worker starves → zero
    // decode/convert cost), resuming from its prior currentTime on re-entry.
    setActiveVideoV5Refs(videoSourcesOf(nodes, "video_v5"));
    // WAKE SET (repaint gate above): the video/scrubber sources the CURRENT frame
    // actually draws (post-cull) — an off-screen or off-slide frame must not wake
    // the editor. Rebuilt every paint so a newly-shown clip is picked up at once.
    // Includes "video_v5" so the V5 frame nudge wakes only for on-screen V5 clips —
    // and "video_v5_scrub", which rides the SAME V5 frame nudge (onVideoV5Frame):
    // omitting it let a settled scrub's decoded frame be dropped by this gate, so
    // the canvas kept a stale frame until some unrelated repaint happened.
    // "filmstrip" is here for exactly that reason: its frames ARE V5 scrub frames
    // (one `videoV5Frame` op per cell — plugins/filmstrip.js), so each cell's decode
    // notifies through onVideoV5Frame and the strip fills in cell by cell. Omitting it
    // would leave a freshly sourced strip showing its first-decoded frame in every cell
    // until an unrelated repaint happened.
    currentMediaRefs = videoSourcesOf(nodes, "video", "video_scrub", "video_v5", "video_v5_scrub", "filmstrip");
    // VIDEO V6 OVERLAY FEED (additive): the post-cull visible video_v6 nodes + the
    // view + scene device size for VideoV6Overlay (its own WebGPU/WebGL2 canvas
    // above the scene). It gates + draws its own <video> elements; Skia draws only
    // each widget's backing rect (plugins/demo/video_v6.js emit()). A culled/off-
    // slide video_v6 is simply absent from `nodes`, so the overlay pauses it.
    videoV6Nodes = nodes.filter((n) => n.type === "video_v6");
    videoV6View = view;
    videoV6Device = { w: canvasEl.width, h: canvasEl.height };
    // VIDEO V7 OVERLAY: build the per-widget descriptors from the SAME post-cull
    // `nodes` + viewport so its canvases stay pixel-aligned with the scene and
    // an off-view (culled/off-slide) clip drops out → its <video> is paused.
    // The overlay draws itself via requestVideoFrameCallback, independent of
    // this paint loop; assigning a fresh array just re-runs its reconcile.
    videoV7Descs = videoV7Descriptors(nodes, view);
    // VIDEO V8 GATE (same off-view=zero-cost rule, separate registry): pause every
    // V8 clip NOT in the post-cull visible set, and gate the repaint wake to the
    // V8 sources this frame actually draws.
    const v8Refs = videoV8SourcesOf(nodes);
    setActiveVideoV8Refs(v8Refs);
    currentV8Refs = v8Refs;
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
      // resolvedBackgroundFill: a MATERIAL background must resolve here — this
      // rect never passes sceneIR (the camera-background freeze).
      rectCmd({ x: camRect.x, y: camRect.y, w: camRect.w, h: camRect.h, fill: resolvedBackgroundFill(camRect.background, nodes) }),
      ...sceneIR(nodes, { pdfDisplay }),
    ];
    // THE camera's dither settings drive the whole-frame final pass (scatters
    // 8-bit banding into grain). Read from the SAME folded state the scene came
    // from; "off" (the default) is a byte-for-byte no-op. `antialias` is THE
    // camera's per-draw coverage-AA — the LIVE edge-smoothing control (no surface
    // recreation): "off" ⇒ crisp jagged edges, "standard" ⇒ smooth (the default).
    gpu.render(ir, view, { background: [0, 0, 0, 0], dither: cameraDither(state), antialias: antialiasCoverage(cameraAntialias(state)) });
    // VIDEO V8 OVERLAY: draw the live frames on the stacked overlay canvas AFTER the
    // Skia scene, using the SAME view + device size so the quads pin exactly over
    // each widget's poster. Draws nothing (a transparent clear) when no V8 clip is
    // on-screen. No-op until the async backend is ready.
    videoV8?.paint(nodes, view, canvasEl.width, canvasEl.height);
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
   *  a dropped .zip → import it as a NEW project and open it (never an asset
   *  upload — see isProjectZip); other OS files → upload each, then insert at
   *  the drop point. A failure in any step is REPORTED loudly (console.error)
   *  — a user gesture must never fail silently, and an event handler has no
   *  caller to rethrow to. app.importProjectZip ALSO surfaces its own result /
   *  refusal in the UI, so a rejected archive is visible without the console. */
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
      // A .zip REPLACES what is on screen (it opens as its own project), so the
      // first one wins and the rest of the drop is refused rather than each
      // archive clobbering the last one's freshly-opened editor.
      const zips = files.filter(isProjectZip);
      if (zips.length > 0) {
        if (zips.length > 1) {
          reportAction(`PowerRP: dropped ${zips.length} .zip archives — each is a whole project, so only "${zips[0].name}" was imported. Drop the others one at a time.`);
        }
        return await app.importProjectZip(zips[0]);
      }
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

  // WHAT DOUBLE-CLICK DOES IS THE WIDGET'S OWN BUSINESS. This handler resolves
  // the hit widget's declared ACTIVATION through web/widget_handlers.js and calls
  // it with a context of canvas SERVICES — it knows no widget type and gains no
  // branch when a new KIND of activation ships. The five behaviours that used to
  // be an if-chain here (the equation editor, a canvas palette, the in-place text
  // editors, the media asset picker) are now five entries in that registry, in
  // the same precedence order, and interior explore mode is the sixth.

  /**
   * Pure function. A world point in a node's own LOCAL (pre-transform) frame —
   * the frame a plugin's emit(), hitTest() and `interiorView` all speak. Inverts
   * the node's world similarity transform (core/transform.js).
   *
   * @example // localPointOf({world: {x: 10, y: 0, rotation: 0, scale: 2}}, 16, 8) // {x: 3, y: 4}
   */
  function localPointOf(node, wx, wy) {
    return T.apply(T.invert(node.world), wx, wy);
  }

  /**
   * THE ACTIVATION CONTEXT — the services a widget's activation handler may use.
   * Everything that touches the document goes through `app` (so preview/commit/
   * undo semantics are the house ones and no handler invents its own); everything
   * that needs the CANVAS is a named service here.
   */
  function activationContext(hit, e) {
    const w = worldPoint(e);
    return {
      app,
      node: hit,
      plugin: hit.plugin,
      pointer: { world: w, local: localPointOf(hit, w.x, w.y), screen: screenPoint(e) },
      /** Command. Mounts the widget's own canvas-overlay palette (CanvasToolbar,
       * built from the plugin's floatingToolbar descriptor). */
      showOverlayPalette(itemId) {
        floatingToolbarItemId = itemId;
      },
      /** Command. Hands canvas input to THIS handler's declared `mode` until Esc. */
      enterMode() {
        app.enterCanvasMode(handlerFor("activate", hit.plugin).id, hit.itemId);
      },
    };
  }

  /** Command. Runs the double-clicked widget's OWN activation — whatever it
   *  declares. A widget declaring none does nothing (a dblclick on a rect). */
  function onDblClick(e) {
    // A live multi-step CREATION owns the double-click: it is the second of the two
    // finalize gestures the request names ("I hit enter to finalize or double click
    // to finalize"). The clicks that made it already landed their vertices — the
    // second one coincides with the first's, which the handler absorbs — so this
    // only has to say "done".
    //
    // GATED ON THE MODE'S OWN `finishGesture` DECLARATION, which is also what
    // core/shortcut_entries.js generates the chip from — so the gesture and its
    // announcement are one fact and cannot drift. It used to finalize ANY live
    // creation, which was wrong twice over: the telescopic rig declares no such
    // gesture and its finalize ABANDONS an incomplete sequence, so a stray
    // double-click silently discarded a half-built rig with nothing on the bar
    // having offered it. A mode that does not declare the gesture now consumes the
    // double-click and does nothing, which is exactly what the empty bar says.
    if (creation) {
      if (creation.mode.finishGesture) finishCreation();
      return;
    }
    if (drag || modal || app.canvasMode) return; // never open mid-gesture or mid-mode
    const w = worldPoint(e);
    const hit = pickNode(app.nodes(), w.x, w.y, SNAP_PX / viewport.zoom);
    if (!hit) return;
    const handler = handlerFor("activate", hit.plugin);
    if (!handler) return;
    // A double-click leaves a DOCUMENT TEXT SELECTION behind (measured: 1 range of
    // whitespace, from the canvas chrome around the click), and the next drag that
    // starts on it makes the browser begin an HTML5 drag-and-drop of that selection
    // — which fires `pointercancel` and kills our drag after ONE pointermove. It hit
    // interior explore mode first (its pan begins right after the double-click that
    // enters it), but it was never mode-specific: ANY canvas drag following ANY
    // double-click loses itself the same way. Dropping the selection here fixes the
    // class, in the one place double-clicks are handled. The in-place editors are
    // unaffected — each owns its own field/caret and mounts AFTER this line.
    window.getSelection()?.removeAllRanges();
    handler.run(activationContext(hit, e));
  }

  // ── WIDGET CANVAS MODE (an activation owning canvas input) ──────────────────
  // While app.canvasMode is set, the mode's handler receives drags and the wheel
  // instead of the canvas's own select/pan/zoom, and App.svelte's HintBar shows
  // that mode's registered inputs. Both records are NON-reactive bookkeeping
  // (like `drag`): nothing paints from them.
  let modeDrag = null; // {lastWorld} while the pointer is down inside a mode
  let modeZoomIdle = null; // pending wheel-idle timer (what ENDS a zoom gesture)

  /** Query. The live ACTIVATION mode as {handler, mode, node}, or null when no mode
   *  is active, the live mode belongs to another phase (a creation mode has no item
   *  — see creationMode() below), its handler declares no mode, or its item has
   *  vanished (purged / deactivated / slid away mid-mode). */
  function activeMode() {
    if (!app.canvasMode) return null;
    const handler = findHandler(app.canvasMode.handlerId);
    if (handler.phase !== "activate" || !handler.mode) return null;
    const node = app.nodes().find((n) => n.itemId === app.canvasMode.itemId);
    return node ? { handler, mode: handler.mode, node } : null;
  }

  /** The mode handler's context, rebuilt per event so `node` carries the CURRENT
   *  (preview-inclusive) state each gesture step accumulates onto. */
  function modeContext(active) {
    return { app, node: active.node, plugin: active.node.plugin };
  }

  /** Command. Ends the live mode gesture: commits whatever the gesture staged as
   *  ONE undo unit. Idempotent (commitPreview no-ops with nothing staged), so
   *  pointer-up and the wheel-idle timer may both call it. */
  function endModeGesture() {
    if (modeZoomIdle !== null) {
      clearTimeout(modeZoomIdle);
      modeZoomIdle = null;
    }
    app.commitPreview();
  }

  /** Command. The wheel inside a canvas mode drives the WIDGET, not the canvas:
   *  stopPropagation keeps the event from the PanZoom container above. The mode
   *  receives the WHOLE wheel gesture — `ctrlKey` (what a trackpad pinch sends),
   *  the raw deltaY for an exponential zoom, and the scroll delta already
   *  converted to the widget's LOCAL px frame for a two-finger pan — and decides
   *  which it is, exactly as PanZoom's own handleWheel does for the canvas. The
   *  host does not classify the gesture, because which axis of it means what is
   *  the widget's business.
   *
   *  ONE undo unit per gesture — every tick stages a preview, and the commit fires
   *  once the wheel has been quiet for ZOOM_GESTURE_IDLE_MS (a wheel has no "up"
   *  event, so a pause is what ends the gesture). Outside a mode this is inert and
   *  the canvas's own wheel pan/zoom runs exactly as before. */
  function onWheel(e) {
    const active = activeMode();
    if (!active?.mode.onWheel) return;
    e.preventDefault();
    e.stopPropagation();
    const w = worldPoint(e);
    const local = localPointOf(active.node, w.x, w.y);
    // The scroll delta as a LOCAL-frame vector: the same two-point difference
    // modePointerMove takes, so one conversion law serves both gestures.
    const shifted = localPointOf(active.node, w.x + e.deltaX / viewport.zoom, w.y + e.deltaY / viewport.zoom);
    active.mode.onWheel(modeContext(active), {
      dLocalX: shifted.x - local.x, dLocalY: shifted.y - local.y,
      deltaY: e.deltaY, ctrlKey: e.ctrlKey || e.metaKey,
      lx: local.x, ly: local.y,
    });
    if (modeZoomIdle !== null) clearTimeout(modeZoomIdle);
    modeZoomIdle = setTimeout(() => { modeZoomIdle = null; app.commitPreview(); }, ZOOM_GESTURE_IDLE_MS);
  }

  /** Command. Re-derives what an ACTIVATE mode's overlay paints. An activate mode
   *  has no session for the host to watch (its item already exists), so every hook
   *  that can change the preview calls this — refreshCreationPreview's "re-derive
   *  after every mutation" rule, one phase over. */
  function refreshModePreview(active) {
    placePreview = active.mode.overlay ? active.mode.overlay(modeContext(active)) : null;
  }

  /**
   * Command. A bare pointer-MOVE inside a canvas mode, offered to the mode as a
   * HOVER: the widget under the pointer plus the point in both frames, exactly the
   * payload `onPick` gets, so a mode's preview and its action read the same thing.
   * Returns true when it consumed the event.
   *
   * THE OVERLAY IS ONLY REASSIGNED WHEN THE HOOK SAYS THE PREVIEW CHANGED. A hover
   * that invalidates per pixel is the defect behind the minimap drag spike and the
   * idle-callback stalls, and a mode's candidate typically changes only when the
   * pointer crosses into a different cell or widget — so the hook returns a boolean
   * and the repaint rides it, rather than firing on every mousemove.
   *
   * The one `app.nodes()` here replaces the one the anchor-hover branch below would
   * have made (a mode consumes the move before it), so the cost of moving the mouse
   * is unchanged rather than doubled.
   */
  function modePointerHover(e) {
    const active = activeMode();
    if (!active?.mode.onHover) return false;
    const w = worldPoint(e);
    const changed = active.mode.onHover(modeContext(active), {
      node: pickNode(app.nodes(), w.x, w.y, SNAP_PX / viewport.zoom),
      world: w,
      local: localPointOf(active.node, w.x, w.y),
    });
    if (changed) refreshModePreview(active);
    return true;
  }

  /**
   * THE LIVE MODE'S PICK LIST, or null. A mode may declare `list(ctx)` returning
   * `{label, pick(node), hover(node|null)}` — the SECOND input path for a pick whose
   * target cannot always be reached on canvas. Null while the mode has nothing to
   * offer (a bento with no cell aimed yet has no cell to bind into), so the surface
   * appears exactly when it can act.
   *
   * `node` is carried through for the panel's anchor (it hangs off the mode's own
   * widget). The mode's `pick`/`hover` are wrapped so the overlay is re-derived
   * afterwards — the same refreshModePreview the pointer hooks use, so a pick from
   * the list and a click on the canvas leave the canvas in the same state.
   */
  let modeList = $derived.by(() => {
    // app.canvasMode FIRST, before activeMode(): activeMode() calls app.nodes(), which
    // is a FULL re-derivation, and this $derived re-runs on every document change. The
    // gate keeps the cost at exactly zero outside a mode — the "hovering must be free"
    // rule applies to anything that runs per document change too.
    if (!app.canvasMode) return null;
    const active = activeMode();
    if (!active?.mode.list) return null;
    const ctx = modeContext(active);
    const declared = active.mode.list(ctx);
    if (!declared) return null;
    return {
      node: active.node,
      label: declared.label,
      pick: (n) => { declared.pick(n); refreshModePreview(active); },
      hover: (n) => { if (declared.hover(n)) refreshModePreview(active); },
    };
  });

  /** Command. The pointer LEFT the canvas — a mode's hover candidate must not
   *  outlive the pointer that asked for it. Silent no-op for a mode with no hover. */
  function modePointerLeave() {
    const active = activeMode();
    if (!active?.mode.onHoverLeave) return;
    if (active.mode.onHoverLeave()) refreshModePreview(active);
  }

  /** Command. Pointer-down inside a canvas mode starts a PAN gesture (one undo
   *  unit, committed on release). Returns true when it consumed the event. */
  function modePointerDown(e) {
    const active = activeMode();
    // A mode that declares `onPick` takes the press as a WIDGET PICK, not a drag:
    // it is handed the widget UNDER the pointer (null on empty canvas) plus the
    // point in world AND in the mode item's own local frame, and decides which of
    // the two it cares about. That is the eyedropper primitive — "click a widget
    // and take its reference" — and it OUTRANKS onPan because one press cannot
    // both be consumed as a pick and open a drag. preventDefault for the same
    // measured reason the pan branch below needs it (a mode is entered by
    // double-clicking, which leaves a document text selection behind).
    if (active?.mode.onPick) {
      e.preventDefault();
      const w = worldPoint(e);
      active.mode.onPick(modeContext(active), {
        node: pickNode(app.nodes(), w.x, w.y, SNAP_PX / viewport.zoom),
        world: w,
        local: localPointOf(active.node, w.x, w.y),
      });
      refreshModePreview(active);
      return true;
    }
    if (!active?.mode.onPan) return false;
    // preventDefault SUPPRESSES THE NATIVE DRAG, and this gesture is the one place
    // in the app that needs it: a mode is entered by DOUBLE-CLICKING, a double-click
    // leaves a document text selection behind, and dragging a selection starts an
    // HTML5 drag-and-drop — which makes the browser fire `pointercancel` and hand
    // us a pointerup after the FIRST move. Measured: without this, an interior pan
    // travelled exactly one pointermove and then stopped (tests/activation_probe.js
    // logs `DOC:dragstart | pointercancel`). The canvas's other drag kinds never
    // follow a double-click, which is why they have never needed it.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    modeDrag = { lastWorld: worldPoint(e) };
    app.dragging = true; // the shared "a gesture is in flight" gate (thumbnails hold)
    return true;
  }

  /** Command. Pointer-move inside a live mode pan: hands the handler the pointer
   *  travel in the widget's LOCAL px frame (the frame its interior lives in), so a
   *  rotated or scaled widget pans along its own axes. */
  function modePointerMove(e) {
    const active = activeMode();
    if (!modeDrag || !active?.mode.onPan) return;
    const w = worldPoint(e);
    const a = localPointOf(active.node, modeDrag.lastWorld.x, modeDrag.lastWorld.y);
    const b = localPointOf(active.node, w.x, w.y);
    modeDrag.lastWorld = w;
    active.mode.onPan(modeContext(active), { dLocalX: b.x - a.x, dLocalY: b.y - a.y });
  }

  /** Command. Release ends the pan gesture (one undo unit). */
  function modePointerUp() {
    if (!modeDrag) return;
    modeDrag = null;
    app.dragging = false;
    endModeGesture();
  }

  // A pending wheel-idle timer must not outlive the component: unmounting (entering
  // the presenter, closing the document) would otherwise let it commit into a doc
  // nobody is looking at any more. app.exitCanvasMode() commits whatever was staged
  // at the boundary itself, which is the honest place for it.
  $effect(() => () => {
    if (modeZoomIdle !== null) clearTimeout(modeZoomIdle);
  });

  // ── MULTI-STEP CREATION MODE (web/creationSteps.js) ─────────────────────────
  // A create-phase handler may declare a `mode` with a STEP LIST instead of
  // finishing on the first release: a polygon collects clicks until you say stop,
  // the telescopic rig collects two boxes. While one is live it owns the pointer,
  // its current step's `hint` is the HintBar's mouse chip, and Escape abandons.
  //
  // THE SESSION IS NOT DOCUMENT STATE and not a preview: mid-flow no item exists
  // yet, so there is nothing to setPreview onto. It is a plain non-reactive record
  // (like `drag`), and what PAINTS is `placePreview` — the same split every other
  // gesture uses. That is what makes Escape leave the document byte-identical and
  // the undo log untouched: nothing was ever written.
  let creation = null; // {handler, mode, plugin, params, session, boxDrag} while live

  /** Pure function. The step a live creation is on, clamped into the declared list
   *  (a repeating final step never runs out — currentStepIndex). */
  function currentStep() {
    const steps = creation.mode.steps;
    return steps[currentStepIndex(steps, creation.mode.step(creation.session))];
  }

  /** Query + command seam. The context a creation-mode hook receives: `app` for
   *  every document write (so preview/commit/undo semantics stay the house ones),
   *  the armed `plugin` (a widget's defaults) or `params` (a rig's options), and
   *  `finish()` — a REQUEST, not a call: the host finalizes after the hook returns,
   *  so a handler cannot re-enter finalize from inside its own onStep. */
  function creationContext() {
    const ctx = {
      app,
      plugin: creation.plugin,
      params: creation.params,
      finishRequested: false,
      finish() { ctx.finishRequested = true; },
    };
    return ctx;
  }

  /** Command. Re-derives what the overlay paints from the live session. Called
   *  after every session mutation — the refreshBandPreview pattern. */
  function refreshCreationPreview() {
    placePreview = creation ? creation.mode.overlay(creation.session) : null;
  }

  /**
   * Command (updates the snap `guides`; returns the pointer payload). The ONE
   * pointer reading every creation hook gets. The point is snapped through the
   * SAME solveSnap creation placement already uses (snapPoint), so a polygon vertex
   * lands on another widget's anchor exactly like a placed box corner does; the
   * modifier flags are re-read from the event EVERY time (never frozen at press),
   * which is what makes Shift live with no rebase bookkeeping.
   *
   * A "box" step keeps its START point's guide visible for the whole drag
   * alongside the live one — placementDrag's own rule, and the reason this reads
   * `creation.boxDrag`.
   */
  function creationPointerFor(e) {
    const w = worldPoint(e);
    const live = snapPoint(w.x, w.y);
    guides = [...(creation.boxDrag?.startGuides ?? []), ...live.guides];
    return creationPointer(
      { x: live.x, y: live.y },
      { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey },
      SNAP_PX / viewport.zoom,
      null,
    );
  }

  /** Query (reads creation.boxDrag). The world rect an in-flight "box" step would
   *  place right now: the dragged rect through the shared creationRect math
   *  (so Shift/Cmd read exactly as they do for a single-gesture box), or — before
   *  the click slop is crossed, i.e. a plain CLICK — the step's declared
   *  `clickSize` centred on the press point (placeByBBox's centring rule). */
  function creationBoxRect(p) {
    const b = creation.boxDrag;
    if (!b.moved) {
      const size = currentStep().clickSize;
      return { x: b.startWorld.x - size.w / 2, y: b.startWorld.y - size.h / 2, w: size.w, h: size.h };
    }
    const [x0, y0, x1, y1] = creationRect(b.startWorld.x, b.startWorld.y, p.world.x, p.world.y, p.mods);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Command. Hands the handler ONE completed gesture, republishes which step is
   *  now current (the HintBar narrates off app.canvasMode.step), and finalizes if
   *  the handler asked to. */
  function creationStep(p) {
    const ctx = creationContext();
    creation.mode.onStep(ctx, creation.session, p);
    app.setCanvasModeStep(creation.mode.step(creation.session));
    refreshCreationPreview();
    if (ctx.finishRequested) finishCreation();
  }

  /**
   * Command. Enters `handler`'s creation mode for the armed gesture and hands it
   * the very pointer-down that started it — so the FIRST gesture takes exactly the
   * same path as the second and the tenth, and there is no first-click special
   * case to drift.
   *
   * The armed CROSSHAIR is deliberately NOT cleared (app.exitCanvasMode disarms it
   * when the session ends): a multi-step placement wants the placement cursor for
   * every step, and a mode already OUTRANKS an armed crosshair for both pointer
   * routing and hints, which core/shortcut_entries.js `armedAny` documents.
   */
  function beginCreation(handler, armed, e) {
    const params = armed.params ?? {};
    app.enterCanvasMode(handler.id, null);
    creation = {
      handler,
      mode: handler.mode,
      plugin: armed.plugin ?? null,
      params,
      session: handler.mode.begin(params),
      boxDrag: null,
    };
    creationPress(e);
  }

  /** Command. A press inside a live creation mode. A "point" step lands its result
   *  HERE, on the DOWN — a vertex must appear under the finger, not on release. A
   *  "box" step opens a sub-drag with the same click-vs-drag slop tracking every
   *  other drag kind uses, and completes on the release. */
  function creationPress(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    hoverAnchor = null; // a hover tip must not linger frozen through the gesture
    if (currentStep().gesture === "box") {
      const p = creationPointerFor(e);
      creation.boxDrag = { startWorld: p.world, startGuides: guides, downScreen: screenPoint(e), moved: false };
      app.dragging = true; // the shared "a gesture is in flight" gate (thumbnails hold)
      creationHover(e);
      return;
    }
    creationStep(creationPointerFor(e));
  }

  /** Command. A move inside a live creation mode — with or without the button
   *  down, because a chain's rubber band and a close-loop highlight must track a
   *  bare hover. Deliberately sets NO app.dragKind: the modifier chips for a
   *  creation step come from the step's own declaration (scoped to the mode), so
   *  borrowing a drag kind would announce them through a predicate the mode
   *  excludes and they would never show. */
  function creationHover(e) {
    const b = creation.boxDrag;
    if (b && !b.moved) {
      const s = screenPoint(e);
      if (Math.hypot(s.x - b.downScreen.x, s.y - b.downScreen.y) > CLICK_SLOP_PX) b.moved = true;
    }
    const p = creationPointerFor(e);
    creation.mode.onHover(creation.session, b ? { ...p, rect: creationBoxRect(p) } : p);
    refreshCreationPreview();
  }

  /** Command. A release inside a live creation mode: completes a "box" step. A
   *  "point" step already landed on the press, so the release is a no-op. */
  function creationRelease(e) {
    if (!creation.boxDrag) return;
    const p = creationPointerFor(e);
    const rect = creationBoxRect(p);
    creation.boxDrag = null;
    app.dragging = false;
    creationStep({ ...p, rect });
  }

  /**
   * Command (ONE undo unit, or nothing). Finalizes the live creation: the handler
   * writes the document ONCE (its own `finalize`), or ABANDONS by writing nothing
   * when the sequence is too short to mean anything.
   *
   * The session is dropped BEFORE finalize runs, because finalize's `addItem`
   * selects what it created and the selection setter leaves the canvas mode — so
   * the abandon effect below would otherwise fire in the middle of the commit and
   * clear state finalize is still using.
   */
  function finishCreation() {
    if (!creation) return;
    const { mode, session } = creation;
    const ctx = creationContext();
    abandonCreation();
    mode.finalize(ctx, session);
    app.exitCanvasMode();
  }

  /** Command. Drops the in-flight creation, leaving NOTHING behind: no item, no
   *  keyframe, no undo entry, no preview (none was ever staged) — only this
   *  component's own scratch state and the overlay it painted. */
  function abandonCreation() {
    creation = null;
    placePreview = null;
    guides = [];
    app.dragging = false;
  }

  // Leaving the canvas mode by ANY route drops the session: Escape (the mode's
  // generated registry entry calls app.exitCanvasMode), a slide switch, entering
  // the presenter, or the selection write inside finalize. Watching app.canvasMode
  // is the ONE place that covers every route, rather than one hook per exit.
  // An ACTIVATE mode's overlay (bento cell aiming) rides the SAME placePreview
  // channel and has no session to abandon, so leaving the mode must drop it here
  // too — otherwise an aimed cell outline would outlive its mode.
  $effect(() => {
    if (app.canvasMode) return;
    if (creation) abandonCreation();
    placePreview = null; // only a live mode ever sets it, so null is always right here
  });

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
    // A widget CANVAS MODE owns the pointer: its handler decides what a press does
    // (land a polygon vertex, start the rig's next box, pan a widget's interior),
    // and the canvas's own pick/drag/band machinery below never sees the gesture.
    // Checked FIRST for the same reason the modal-transform check is early: a
    // takeover that let a stray selection happen underneath would defeat the point
    // of taking over.
    if (creation) {
      creationPress(e);
      return;
    }
    if (modePointerDown(e)) return;
    // Any canvas pointer-down dismisses an open floating toolbar (clicks INSIDE
    // the toolbar land on its own DOM overlay, not this SVG, so they don't reach
    // here — the toolbar stays open while you pick from it). A fresh double-click
    // reopens it.
    //
    // EXCEPT while the bar's OWN item is in a live canvas mode. Interior explore
    // deliberately leaves the plain drag to the canvas so the widget stays
    // movable, and a bar that vanished on the first such drag would take the
    // mode's only visual indication with it. The mode owns the bar for as long as
    // it runs; a press on ANOTHER item exits the mode (app.selection's setter) and
    // the next press then closes the bar normally.
    if (app.canvasMode?.itemId !== floatingToolbarItemId) floatingToolbarItemId = null;
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
      // A PLACEMENT whose create handler declares a MULTI-STEP mode takes over
      // instead of running a one-gesture placement, and its arm survives the press
      // (see beginCreation) — so this is resolved BEFORE the one-shot clear below.
      // A RIG names its handler on the arm itself; a widget's comes from its plugin
      // declaration, exactly as placementUp resolves it.
      if (armed.kind === "place") {
        const create = armed.plugin ? handlerFor("create", armed.plugin) : getHandler("create", armed.handlerId);
        if (create.mode) {
          beginCreation(create, armed, e);
          return;
        }
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      app.crosshair = null;
      hoverAnchor = null; // a hover tip must not linger frozen through the drag
      app.dragging = true;
      if (armed.kind === "band") {
        drag = { kind: "band", mode: armed.mode, startWorld: w, lastWorld: w };
        // Seed the modifier record from the DOWN event: a mode armed by the B
        // key / toolbar / palette and then shift- (or alt-/mod-) dragged must
        // apply that verb from the very first frame, not only once a key event
        // happens to fire. refreshBandPreview then states the pending change
        // immediately (for a zero-size box that is "the current selection is
        // about to be dropped" under the unmodified verb — honest, not blank).
        bandMods = modifiersOf(e);
        refreshBandPreview();
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
    const tol = SNAP_PX / viewport.zoom;
    const hit = pickNode(nodes, w.x, w.y, tol);
    // ── SELECTED-OBJECT DRAG PRIORITY (PowerPoint parity) ─────────────────────
    // Precedence #2 (after resize/rotate handles, before the topmost hit-test):
    // once objects are selected, grabbing a selected object moves THAT selection
    // even when a DIFFERENT object is stacked ON TOP at the grab point — exactly
    // how a handle already overrides the topmost pick (handles do it via a DOM
    // overlay + stopPropagation; the body has no covering element, so the
    // override lives here). Two tiers of "grabbing a selected object":
    //   2a — press ON its actual shape (fill/rim): `pickNode` restricted to the
    //        selected nodes, reused not re-derived.
    //   2b — press anywhere inside its BOUNDING BOX (the rotation-aware OBB the
    //        handles frame) EVEN in the empty gaps a thin line / star /
    //        circle-corner / rotated rect leaves — `pointInNodeBox`. Multi-select:
    //        any selected member's box counts (topmost first, mirroring pickNode),
    //        which naturally covers the collective box. moveBy-only widgets
    //        (arrows: no w/h) have no box, so 2b skips them and they keep 2a.
    // The override engages ONLY when the global topmost `hit` is NOT already a
    // selected object (grabbing a selected object that is itself on top needs no
    // override — `grab = hit` handles it), so behavior with nothing else stacked
    // is byte-identical to before. Shift is excluded (its multi-select /
    // axis-lock path is untouched). The top object (if any) is remembered in
    // `clickSelectId`: a plain CLICK (no drag past the slop) still selects it on
    // release (PPT lets a click cycle selection to the thing on top) — only a
    // real DRAG keeps the priority. `hit === null` (empty box gap, nothing on
    // top) leaves clickSelectId null, so a click there just keeps the selection.
    let overrideSel = null;
    let clickSelectId = null;
    if (!e.shiftKey) {
      const selIds = app.selectedIds();
      if (selIds.length && !(hit && selIds.includes(hit.itemId))) {
        const selSet = new Set(selIds);
        const selNodes = nodes.filter((n) => selSet.has(n.itemId));
        // 2a shape, else 2b oriented box (scan top-down = pickNode's topmost rule).
        const onSel = pickNode(selNodes, w.x, w.y, tol) ?? selNodes.findLast((n) => pointInNodeBox(n.state, w.x, w.y));
        if (onSel && (onSel.plugin.capabilities.transform || onSel.plugin.moveBy)) {
          overrideSel = onSel;
          clickSelectId = hit?.itemId ?? null;
        }
      }
    }
    const grab = overrideSel ?? hit; // the object a body-drag actually grabs
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
    // `!overrideSel`: a press with no shape hit but INSIDE a selected object's
    // box (2b above) is NOT empty space — it grabs that selection (falls through
    // to the move-drag setup) instead of band-selecting. Only a press outside
    // EVERY selected box (and no hit) reaches the band here.
    if (!e.shiftKey && !hit && !overrideSel) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag = { kind: "band", mode: app.bandMode, startWorld: w, lastWorld: w };
      // Same seed as the armed path above. Shift is excluded from THIS entry
      // point (see the comment above), so the record can only carry alt/mod
      // here — a shift-held SUBTRACT band must be started from an armed mode
      // (B key / toolbar / palette) or by pressing Shift after the drag begins.
      bandMods = modifiersOf(e);
      refreshBandPreview();
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
    // `overrideSel` KEEPS the current selection (we are about to drag it, not
    // replace it) — the topmost object is instead selected on click-release.
    if (!e.shiftKey && !overrideSel && !(hit && app.selectedIds().includes(hit.itemId)))
      app.selection = hit?.itemId ?? null;
    // Draggable = has a transform (x/y) OR a moveBy hook (arrow shaft drag
    // translates its endpoints — manifest round 5: "Both must work"). `grab` is
    // the selection-priority pick when overriding, else the topmost `hit`.
    if (!grab || !(grab.plugin.capabilities.transform || grab.plugin.moveBy)) {
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
      itemId: grab.itemId,
      plugin: grab.plugin,
      // Pending shift-click toggle: set only when Shift is down. onPointerUp
      // toggles this item's membership IFF the gesture never crossed the slop
      // (a plain shift-DRAG leaves it untouched — it's an axis-locked move).
      toggleId: e.shiftKey ? grab.itemId : null,
      // Selection-priority override only: the topmost object to select if this
      // gesture turns out to be a plain CLICK (see onPointerUp). null otherwise.
      clickSelectId,
      downScreen: screenPoint(e),
      moved: false,
      // moveBy needs the RAW stored state: equation-bound coordinates must be
      // recognized (strings) so they stay anchored instead of translating.
      rawItem: app.rawState().items?.[grab.itemId],
      startWorld: w,
      startX: grab.state.x ?? 0,
      startY: grab.state.y ?? 0,
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
      centerWorld: grab.plugin.capabilities.bbox
        ? T.apply(grab.world, (grab.state.w ?? 0) / 2, (grab.state.h ?? 0) / 2)
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
    // A live widget CANVAS MODE pan consumes the move (see modePointerDown).
    if (creation) {
      creationHover(e);
      return;
    }
    if (modeDrag) {
      modePointerMove(e);
      return;
    }
    // A mode that declares `onHover` owns the bare pointer-move: it previews what a
    // press would do, and the canvas's own anchor hover-tip would be competing noise
    // inside a takeover. Checked here, alongside the pan branch, for the same reason
    // modePointerDown's pick branch sits alongside its own.
    if (!drag && modePointerHover(e)) return;
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
      // equation types before .x/.y (THE UNIFICATION: anchors are variables) —
      // plus the copy-.x/.y chips (task #41 anchor-copy discoverability).
      // HYSTERESIS: a fresh anchor is acquired only inside the tight SNAP_PX
      // zone, but the CURRENTLY-shown anchor is retained out to HOVER_KEEP_PX so
      // the pointer can leave the anchor and reach its copy chips without the
      // tip vanishing. Both radii are expressed in screen px (÷zoom → world).
      let best = null;
      if (app.anchorsVisible) {
        const acquire = SNAP_PX / viewport.zoom;
        const keep = HOVER_KEEP_PX / viewport.zoom;
        for (const n of nodes)
          for (const a of nodeAnchors(n)) {
            const d = Math.hypot(a.x - w.x, a.y - w.y);
            const isCurrent = hoverAnchor?.itemId === n.itemId && hoverAnchor?.anchorId === a.id;
            if (d <= (isCurrent ? keep : acquire) && (!best || d < best.d))
              best = { d, label: app.anchorName(n.itemId, a.id), x: a.x, y: a.y, itemId: n.itemId, anchorId: a.id };
          }
      }
      hoverAnchor = best;
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
    else if (drag.kind === "band") bandDrag(w, e);
    else if (drag.kind === "place") placementDrag(e, w);
    // "shiftpick" = a deferred shift-click on a NON-draggable item: no drag
    // behavior, only the slop tracking above, so the pointer path does nothing.
  }

  // ── Anchor copy discoverability (task #41) ─────────────────────────────────

  /**
   * Command (mutates the system clipboard; flashes the "Copied!" affordance).
   * Copies the currently-hovered anchor's VALID equation reference for one
   * coordinate — the display form `<itemSlug>_<anchorId>.<coord>` built from the
   * hover label (which is `anchorName(itemId, anchorId)` = the referencable
   * base) plus ".x"/".y". This is the SAME grammar the equation field consumes:
   * displayToStored rewrites it to the stored `@<itemId>_<anchorId>.<coord>` the
   * evaluator resolves (verified against core/expressions.js resolveRef). On
   * success the clicked chip flashes a check for COPY_FLASH_MS; a copy failure is
   * reported LOUDLY inside copyText and leaves no flash (never swallowed).
   *
   * @param {"x"|"y"} coord - which coordinate of the anchor point to reference
   */
  async function copyAnchorRef(coord) {
    const h = hoverAnchor;
    if (h?.anchorId == null) return; // only genuine preset-anchor hovers carry itemId/anchorId
    const ref = `${h.label}.${coord}`;
    if (await copyText(ref, "anchor equation reference")) {
      const flashed = { itemId: h.itemId, anchorId: h.anchorId, coord };
      justCopiedAnchor = flashed;
      setTimeout(() => { if (justCopiedAnchor === flashed) justCopiedAnchor = null; }, COPY_FLASH_MS);
    }
  }

  // ── Rubber-band selection drag ─────────────────────────────────────────────

  /**
   * Pure function. A pointer/keyboard event's modifier flags as the band
   * modifier record. `mod` is the platform-agnostic command/control modifier —
   * the SAME `e.metaKey || e.ctrlKey` idiom placementDrag/resizeDrag use for
   * `symmetric`, so no single platform's key is hardcoded. Works on both event
   * kinds because a KeyboardEvent carries the same four flags a PointerEvent
   * does (that is what lets a bare modifier keypress update a live band drag).
   *
   * @param {{shiftKey: boolean, altKey: boolean, metaKey: boolean, ctrlKey: boolean}} e
   * @returns {{shift: boolean, alt: boolean, mod: boolean}}
   *
   * @example modifiersOf({shiftKey: true, altKey: false, metaKey: false, ctrlKey: false}) // {shift: true, alt: false, mod: false}
   * @example modifiersOf({shiftKey: false, altKey: false, metaKey: false, ctrlKey: true}) // {shift: false, alt: false, mod: true}
   * @example modifiersOf({shiftKey: false, altKey: true, metaKey: false, ctrlKey: false}) // {shift: false, alt: true, mod: false}
   */
  function modifiersOf(e) {
    return { shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey };
  }

  /**
   * Pure function. The band-select verb the held modifiers imply, resolved
   * through BAND_MODIFIER_VERBS (first listed match wins; nothing held →
   * BAND_VERB_UNMODIFIED). The ONE reader of that table.
   *
   * @param {{shift: boolean, alt: boolean, mod: boolean}} mods
   * @returns {"replace"|"add"|"subtract"|"invert"}
   *
   * @example bandVerb({shift: false, alt: false, mod: false}) // "replace"
   * @example bandVerb({shift: true, alt: false, mod: false}) // "subtract"
   * @example bandVerb({shift: false, alt: false, mod: true}) // "add"
   * @example bandVerb({shift: false, alt: true, mod: false}) // "invert"
   * @example bandVerb({shift: true, alt: true, mod: false}) // "invert" — alt is listed first, so it wins
   */
  function bandVerb(mods) {
    for (const { held, verb } of BAND_MODIFIER_VERBS) if (mods[held]) return verb;
    return BAND_VERB_UNMODIFIED;
  }

  /**
   * Pure function. The selection a band VERB produces from the currently
   * selected ids and the ids the box CAUGHT. Order/dedupe follow the existing
   * selection helpers (core/bandselect.js groupFilteredSelection): first
   * appearance wins, survivors keep their selection order, newly caught ids land
   * at the END — the same rule app.toggleInSelection uses for a shift-click add.
   *
   *   replace  — the caught set BECOMES the selection (anything selected
   *              outside the box drops out). The unmodified band, unchanged.
   *   add      — caught ids join the selection; nothing already selected is lost.
   *   subtract — caught ids leave the selection; an empty catch is a no-op
   *              (NOT a deselect-all), matching the pre-existing shift band.
   *   invert   — WITHIN THE BOX ONLY, each caught id flips: selected ids in the
   *              box leave, unselected ids in the box join. Ids OUTSIDE the box
   *              are left ALONE (neither dropped nor added), so a box over
   *              nothing is a no-op and inverting the same box twice returns the
   *              original selection.
   *
   * Throws on an unknown verb — there is no silent fallback selection.
   *
   * @param {string[]} selected - currently selected itemIds, in selection order
   * @param {string[]} caught - itemIds the box caught, in scene order
   * @param {"replace"|"add"|"subtract"|"invert"} verb
   * @returns {string[]}
   *
   * @example applySelectionVerb(["a", "b"], ["b", "c"], "replace") // ["b", "c"]
   * @example applySelectionVerb(["a", "b"], ["b", "c"], "add") // ["a", "b", "c"]
   * @example applySelectionVerb(["a", "b"], ["b", "c"], "subtract") // ["a"]
   * @example applySelectionVerb(["a", "b"], ["b", "c"], "invert") // ["a", "c"]
   * @example applySelectionVerb(["a"], [], "subtract") // ["a"] — empty catch changes nothing
   * @example applySelectionVerb(["a"], [], "invert") // ["a"] — outside-the-box ids are untouched
   */
  function applySelectionVerb(selected, caught, verb) {
    const inBox = new Set(caught);
    const isSelected = new Set(selected);
    if (verb === "replace") return [...new Set(caught)];
    if (verb === "add") return [...new Set([...selected, ...caught])];
    if (verb === "subtract") return [...new Set(selected.filter((id) => !inBox.has(id)))];
    if (verb === "invert")
      return [...new Set([...selected.filter((id) => !inBox.has(id)), ...caught.filter((id) => !isSelected.has(id))])];
    throw new Error(`Unknown band-select verb: ${verb}`);
  }

  /**
   * Pure function. The pending CHANGE between two selections: which ids `after`
   * gains and which it loses. The band preview's two buckets — derived by
   * diffing against the SAME applySelectionVerb result the release commits, so
   * the preview cannot drift from the outcome (one rule set, not two).
   *
   * @param {string[]} before
   * @param {string[]} after
   * @returns {{added: string[], removed: string[]}}
   *
   * @example selectionDelta(["a", "b"], ["a", "c"]) // {added: ["c"], removed: ["b"]}
   * @example selectionDelta(["a"], ["a"]) // {added: [], removed: []}
   * @example selectionDelta([], ["a", "b"]) // {added: ["a", "b"], removed: []}
   */
  function selectionDelta(before, after) {
    const had = new Set(before);
    const has = new Set(after);
    return { added: after.filter((id) => !had.has(id)), removed: before.filter((id) => !has.has(id)) };
  }

  /**
   * Query (reads the scene, the live selection and the held modifiers). The FULL
   * selection a release with band rect `rect` would commit: the ids the box
   * catches in the drag's mode (core/bandselect.js: INNER = fully enclosed,
   * OUTER = touching counts; bounds = the conservative rotated world AABB),
   * folded into the current selection by the modifier verb, then run through the
   * SAME group invariant app.selectMany applies (dedupeGroupSelection) so the
   * preview can never promise a set the commit would then filter away.
   *
   * Reading the CURRENT selection live is safe and deliberate: a band drag never
   * writes the selection before release — both entry points in onPointerDown
   * return before any selection assignment — so app.selectedIds() throughout the
   * drag is exactly the pre-drag selection, with no baseline to capture and go
   * stale.
   */
  function bandSelectionAt(rect) {
    const nodes = app.nodes();
    const caught = selectInBox(nodes, rect, drag.mode);
    const next = applySelectionVerb(app.selectedIds(), caught, bandVerb(bandMods));
    return dedupeGroupSelection(next, groupMembership(nodes));
  }

  /**
   * Command (updates band preview state; never touches the document or the
   * selection). Recomputes the world-space band rect from the drag's own
   * endpoints and both preview buckets at the CURRENT modifiers. Called from
   * pointer-down, every pointer move, AND the window key listener below — that
   * last caller is what makes pressing or releasing a modifier update the
   * preview with the pointer standing still (a keypress fires no pointer event,
   * so a move-only recompute would silently lag a mid-drag verb change).
   * A no-op unless a band drag is live.
   */
  function refreshBandPreview() {
    if (drag?.kind !== "band") return;
    bandRect = rectFromCorners(drag.startWorld, drag.lastWorld);
    const { added, removed } = selectionDelta(app.selectedIds(), bandSelectionAt(bandRect));
    bandAddIds = added;
    bandRemoveIds = removed;
  }

  /**
   * Command (updates band preview state). One pointer move of a band drag: the
   * live corner and the modifier record are re-read from the event EVERY move
   * (never frozen at grab time — the same live-modifier rule the axis-lock and
   * resize/placement modifiers follow), then the preview is recomputed.
   */
  function bandDrag(w, e) {
    drag.lastWorld = w;
    bandMods = modifiersOf(e);
    refreshBandPreview();
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
    // WHAT THE FINISHED GESTURE CREATES is the WIDGET's business: `placement` is
    // its creation-phase declaration, resolved through web/widget_handlers.js
    // (phase "create"; absent → "bbox", the default since crosshair placement
    // landed). The two bodies moved there verbatim — the gesture GEOMETRY above
    // (snap, Shift/Cmd modifiers, click-vs-drag slop) stays here because it is the
    // same for every widget. A widget wanting a different creation behaviour (a
    // multi-step placement, an asset prompt, a multi-item rig) registers a handler
    // and names it here-independently: this function does not change.
    handlerFor("create", plugin).place({
      app,
      plugin,
      gesture: { moved: !!drag.moved, startWorld, rect: drag.lastRect, endpoint: drag.lastEndpoint },
    });
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
    // Each member's pairs now omit any axis that didn't move (diffState in
    // translationPairs), so returning EXACTLY to the start yields NO pairs — set
    // the (possibly empty) preview unconditionally so that case reverts to the
    // committed pose instead of freezing at the last non-zero preview.
    app.setPreview(drag.members.flatMap((m) => translationPairs(m, dx, dy)));
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
    // An INVERTED box (the drag passed through the opposite edge — a FLIP,
    // web/canvas/dragKinds.js resizedBox) bypasses snapping for exactly the reason
    // stated above for rotated items: its "left" edge is to the RIGHT of its
    // "right" edge, so every edge→line and size-match comparison here would be
    // reasoning about a rect that does not exist. Skipping is the honest choice
    // rather than producing wrong math; the flip itself still tracks the cursor.
    const inverted = ww < 0 || hh < 0;
    if (!drag.rotated && !inverted && app.snapEnabled && !mods.uniform && !mods.symmetric) {
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

    // Commit ONLY the geometry keys that actually changed vs the resolved
    // start pose (drag.startState) — an east-only stretch writes just `w`, so a
    // stored equation on x/y/h survives untouched (interaction-commit rule).
    // Grabbing an axis that DID move overrides its equation with the literal.
    app.setPreview(itemGeometryPairs(drag.itemId, diffState(s, { x, y, w: ww, h: hh }, ["x", "y", "w", "h"])));
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
    // Only the changed keys vs the group's resolved start (startScale + start
    // x/y) — a pure Cmd-symmetric scale, say, leaves x/y put, so their stored
    // equations survive (interaction-commit rule).
    const start = { scale: drag.startScale, x: drag.startState.x, y: drag.startState.y };
    app.setPreview(itemGeometryPairs(drag.itemId, diffState(start, { scale: gs.scale, x: gs.x, y: gs.y }, ["scale", "x", "y"])));
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
    // Pairs omit unchanged keys (diffState in scaleMemberPairs), so a return to
    // the exact start box yields none — set the preview unconditionally so that
    // reverts rather than freezing at the last non-identity scale (see moveDrag).
    app.setPreview(drag.members.flatMap((m) => scaleMemberPairs(m, kx, ky, ax, ay)));
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
    // ANNOUNCED like every other drag kind (cleared by onPointerUp /
    // cancelPointDrag with the rest of the bookkeeping). An endpoint drag has no
    // modifier hints of its own, but leaving this null made the gesture INVISIBLE
    // to every dragKind-guarded context — including the Escape guard below, so a
    // mid-drag Escape reached App.svelte's `deselect` and cleared the selection
    // out from under the live gesture (measured).
    app.dragKind = "endpoint";
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

  // HANDLES ARE SELECTABLE (the INNER selection scope — app.svelte.js
  // handleSelection). A press on a handle both SELECTS it and arms its drag, and
  // the drag moves the WHOLE selected set by one shared local delta.
  //
  // SHIFT-CLICK TOGGLES MEMBERSHIP, verbatim from the item scope: the same
  // click-vs-drag disambiguation (`toggleId` set at press, applied on release only
  // if the pointer never passed CLICK_SLOP_PX) that onPointerUp already runs for
  // items, so a shift-DRAG on a handle moves the set instead of toggling. Nothing
  // about that release path is duplicated here — it is the same two lines of state.

  function startModifier(id, e) {
    const node = app.selectedNode();
    if (!node) return;
    e.stopPropagation();
    overlayEl.setPointerCapture(e.pointerId);
    hoverAnchor = null; // pre-drag hover tip must not linger stale
    // A plain press on an UNSELECTED handle makes it the selection (so the drag that
    // follows moves what you grabbed); pressing one that is already in the set keeps
    // the set (so you can drag a multi-handle selection by any of its members) —
    // the same "grab does not collapse the selection" rule a body drag follows.
    if (!e.shiftKey && !app.handleSelection.includes(id)) app.selectHandle(id);
    // Every selected handle's LOCAL start position, captured once: the drag applies
    // ONE local delta to these, so the set translates rigidly and no member drifts
    // by accumulating its own rounding.
    const inverse = T.invert(node.world);
    const grabbed = new Set(app.handleSelection.includes(id) ? app.handleSelection : [id]);
    const startLocals = nodeModifierPoints(node)
      .filter((m) => grabbed.has(m.id) && m.apply)
      .map((m) => ({ id: m.id, ...T.apply(inverse, m.x, m.y) }));
    drag = {
      kind: "modifier", itemId: node.itemId, modifierId: id, world: node.world,
      startLocals, downScreen: screenPoint(e),
      // Shift on a handle means "toggle membership" — deferred to release exactly
      // like the item-level shift-click (onPointerUp's `drag.toggleId && !drag.moved`).
      toggleHandleId: e.shiftKey ? id : null,
    };
    app.dragging = true;
    app.dragKind = "modifier";
  }

  // ── POINT CONTEXT MENU (F.18) ────────────────────────────────────────────────
  // Right-clicking a modifier handle that backs a LIST ELEMENT opens a small menu of
  // the point's operations. Its entries are DECLARED by the widget (registry
  // `handleToggles`: curve on/off, new subpath) plus the universal Remove
  // (keyframe-HIDE, the Delete precedent — never purge), so this host knows nothing
  // about paint paths. {x, y} are viewport-fixed screen coords from the event.
  let pointMenu = $state(null);

  /** Command. Opens the point menu on `m` — first SELECTING that handle so the menu
   *  and toolbar act on the same point (the grab-selects rule startModifier follows).
   *  Suppresses the browser's own context menu. */
  function openPointMenu(m, e) {
    if (!m.hasElement) return;
    e.preventDefault();
    e.stopPropagation();
    if (!app.handleSelection.includes(m.id)) app.selectHandle(m.id);
    pointMenu = { x: e.clientX, y: e.clientY, id: m.id };
  }

  /** Command. Closes the point menu (a pick, Escape, or an outside click). */
  function closePointMenu() {
    pointMenu = null;
  }

  /**
   * Query. The point menu's entries for the currently-open handle: one per state the
   * widget declares (checked when ON), then Remove. Each `onselect` routes through
   * the SAME app writes the HandleToolbar uses, so the two surfaces cannot drift.
   * Empty (menu renders nothing) when the handle no longer backs an element.
   */
  function pointMenuEntries() {
    const node = app.selectedNode();
    if (!node || !pointMenu) return [];
    const mp = nodeModifierPoints(node).find((m) => m.id === pointMenu.id);
    if (!mp?.element) return [];
    const raw = node.state?.[mp.element.list.key]?.[mp.element.index];
    if (!raw) return [];
    const entries = (node.plugin.handleToggles ?? []).map((t) => ({
      label: t.label,
      icon: t.icon,
      checked: t.isOn(raw),
      onselect: () => app.transformHandleSelectionElements((el) => t.set(el, !t.isOn(raw))),
    }));
    entries.push({
      label: "Remove",
      icon: "mdi:eye-off",
      danger: true,
      onselect: () => app.setHandleSelectionActive(false),
    });
    return entries;
  }

  /**
   * The modifier-point drag: translates EVERY selected handle by the local delta
   * the grabbed one travelled, as one preview.
   *
   * Each handle's `apply(state, localPoint)` returns a PARTIAL state write, so the
   * set is composed by CHAINING them — each apply reads the state the previous one
   * produced. That is what makes a multi-handle drag work with no plugin changes and
   * no knowledge of what the handles control: two vertices of one polygon both
   * rewrite the whole `points` list, and chaining means the second sees the first's
   * edit instead of clobbering it.
   *
   * The delta is measured in LOCAL space (both the grabbed handle's start and the
   * live pointer are inverted through the SAME node.world), so rotation and scale
   * are correct by construction — the existing single-handle guarantee, unchanged.
   *
   * ONE shared delta, but EVERY handle projects INDEPENDENTLY (core/derive.js's
   * modifierWrite = constrain then apply). The delta is deliberately NOT
   * pre-averaged or pre-constrained across the set: a set holding one constrained
   * handle and one free one must see the free one follow the cursor while the
   * constrained one lags along its own trajectory. That visible lag is the
   * CONSTRAINT BEING HONEST, not drift to smooth away.
   */
  function modifierDrag(w) {
    const node = app.nodes().find((n) => n.itemId === drag.itemId);
    if (!node) return; // item vanished mid-drag (e.g. purged elsewhere) — nothing to preview
    const grabbedStart = drag.startLocals.find((s) => s.id === drag.modifierId);
    if (!grabbedStart) return; // the grabbed handle is gone (its element was purged mid-drag)
    const local = T.apply(T.invert(drag.world), w.x, w.y);
    const dx = local.x - grabbedStart.x, dy = local.y - grabbedStart.y;
    const points = nodeModifierPoints(node);
    let state = node.state, written = {};
    for (const start of drag.startLocals) {
      const mp = points.find((m) => m.id === start.id);
      if (!mp?.apply) continue; // this handle's element vanished — the rest still move
      const partial = modifierWrite(mp, state, { x: start.x + dx, y: start.y + dy });
      state = { ...state, ...partial };
      written = { ...written, ...partial };
    }
    const pairs = Object.entries(written).map(([key, value]) => [["items", drag.itemId, key], value]);
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
   *
   * translationPairs now OMITS an axis that netted to zero (diffState), so an
   * axis a snap pulled exactly back to its start (raw drag == −snap on that
   * axis) has no pair to override and stays a no-op — a negligible bound: the
   * item ended where it began on that axis, so no rebind is the honest result.
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
        if (!grabbed || typeof grabbed[1] !== "number") continue; // moveBy widget, or an axis that netted to zero — nothing to rewrite
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
   * REBUILDS from the current preview's PRESENT geometry keys (resizeDrag now
   * writes only the axes that changed — the snapped size key is always among
   * them, since a resize by definition moved it) rather than writing just the
   * snapped size — setPreview REPLACES previewDelta wholesale, so a narrower
   * call would silently drop the other keys the resize legitimately changed.
   * Keys the resize left alone stay absent, so their stored equations survive.
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

  // ESC_CANCELABLE_DRAG_KINDS (imported above from core/shortcut_entries.js) is
  // the drag kinds Escape CANCELS: the two single-point handle grabs, whose entire
  // effect is a live preview, so dropping the preview IS the cancel. Membership is
  // a PROMISE that cancelPointDrag fully undoes the kind — never add a kind without
  // checking that every piece of state its *Drag() writes is cleared below. Kinds
  // outside the list (move/resize/multiresize/band/place) still fall through to
  // App.svelte's bubble-phase `deselect`, which clears the selection under the live
  // gesture; closing THAT belongs in the registry's own `deselect` predicate (a live
  // drag is not a deselect context) rather than in more capture-phase swallowing
  // here — swallowing a key the HintBar still advertises would trade one wrong
  // action for a lie.
  // IMPORTED rather than redeclared here: the same list is what the registry's
  // "Cancel drag" entry announces and what `deselectable` withholds the Deselect
  // chip for. It used to be a second local copy with a scan-based drift guard over
  // the two, which could only report a divergence after it had shipped; one copy
  // means there is nothing to diverge.

  /** Command. Esc-cancels an in-progress single-point handle drag (manifest:
   * "Esc cancels"): drops the preview (reverting to the committed pose, exactly
   * like modal cancelPreview) and releases drag bookkeeping — including the
   * endpoint drag's live bind feedback (hoverAnchor/dynamicAnchor), which
   * onPointerUp clears on the commit path. A no-op unless such a drag is
   * actually live — called by the capture-phase keydown listener below (the
   * Escape wiring stays self-contained in CanvasView rather than App.svelte's
   * shortcut registry, which dispatches on the bubble phase). The still-captured
   * pointer needs no release: with `drag` null the pointerup is a no-op, so the
   * gesture cannot resurrect or commit. */
  function cancelPointDrag() {
    if (!ESC_CANCELABLE_DRAG_KINDS.includes(drag?.kind)) return;
    drag = null;
    hoverAnchor = null;
    dynamicAnchor = null;
    app.dragging = false;
    app.dragKind = null;
    app.cancelPreview();
  }

  function onPointerLeave() {
    if (!drag && !modal) screenMouse = null; // hide ruler markers on leave (not mid-gesture)
    modePointerLeave(); // a mode's hover candidate must not outlive the pointer
  }

  function onPointerUp(e) {
    if (creation) {
      creationRelease(e);
      return;
    }
    if (modeDrag) {
      modePointerUp();
      return;
    }
    if (!drag) return;
    if (drag.kind === "band") {
      // Apply the band through the SAME query the live preview rendered from
      // (bandSelectionAt), recomputed from the drag's own endpoints rather than
      // the render state so the result is deterministic: the committed set is
      // by construction the set the last preview frame showed. The verb comes
      // from the modifiers held at THIS moment (bandMods, kept live by the
      // pointer moves and the key listener) — releasing over a subtract preview
      // therefore commits a subtract. ONE selectMany call = one selection
      // change; no document write, so a band select adds no undo unit at all
      // (selection is app state, not document state — see app.svelte.js).
      app.selectMany(bandSelectionAt(rectFromCorners(drag.startWorld, drag.lastWorld)));
      bandRect = null;
      bandAddIds = [];
      bandRemoveIds = [];
      bandMods = NO_MODIFIERS;
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
    // The HANDLE-scope form of exactly the same rule, one level down: a shift+press
    // on a handle released within the slop toggles its membership in the handle
    // selection; a shift-DRAG moved the set and is already committed below. Set only
    // by startModifier, so it can never coexist with the item-level toggleId.
    if (drag.toggleHandleId && !drag.moved) app.toggleHandleInSelection(drag.toggleHandleId);
    // SELECTED-OBJECT DRAG PRIORITY (see onPointerDown): a plain click (no drag)
    // on a selected object that had a DIFFERENT object stacked on top selects
    // that top object on release — so a click still cycles selection to the
    // thing on top while a DRAG moved the already-selected object. Set only on a
    // non-shift override grab (never together with toggleId); a real drag
    // (moved) skips it and keeps the selection it just moved.
    if (drag.clickSelectId != null && !drag.moved) app.selection = drag.clickSelectId;
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
      // Unconditional: translationPairs omits an unmoved axis, so a zero-delta
      // grab (initial paint, or a return to origin) yields no pairs and must
      // still set the (empty) preview to hold the committed pose (see moveDrag).
      app.setPreview(modal.members.flatMap((m) => translationPairs(m, dx, dy)));
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
    // The finalize key of a live multi-step CREATION mode (a polygon's Enter),
    // routed through the shortcut registry exactly as the modal's Enter is. The
    // session lives here, so this is where the hook has to be.
    app.finishCanvasMode = () => { if (creation) finishCreation(); };
    // Arrow-key NUDGE (one px per press, one undo unit): the same members and
    // the same translationPairs rule a body drag uses, so an arrow press and a
    // one-pixel drag are byte-identical writes (moveBy widgets move their free
    // coords; equation-bound axes that did not move stay equations).
    app.nudgeSelection = (dx, dy) => {
      const members = translateMembers(app.nodes());
      if (members.length === 0) return;
      app.setPreview(members.flatMap((m) => translationPairs(m, dx, dy)));
      app.commitPreview();
    };
  });

  // Point-handle drag Esc-cancel (manifest ARCHITECTURE PLAN #1: "Esc
  // cancels"). The DISPATCH is a dedicated CAPTURE-phase window listener (the
  // SAME pattern SvelteLib's Dropdown.svelte uses for its outside-click
  // dismiss), NOT App.svelte's bubble-phase registry dispatch — capture matters
  // specifically because App's own "Escape" entries dispatch on the BUBBLE
  // phase (its <svelte:window onkeydown>), and one of them (`deselect`, when:
  // editSelection) has no drag-kind guard — it would clear app.selection out
  // from under an in-progress drag if it ran first. Capture always
  // runs before bubble regardless of listener registration order, so
  // stopPropagation here reliably pre-empts it — but ONLY while a cancelable
  // drag is actually live (every other key, and Escape with no such drag
  // active, passes through untouched to App's normal dispatch).
  // INV5 (Round 18 audit): App.svelte registers a matching DISPLAY-ONLY "Cancel
  // drag" Escape entry so the single-source registry knows this input and the
  // HintBar shows it — the capture listener here remains the mechanism (bubble
  // ordering requires it), mirroring how the A-key/pointer hints are
  // registered-but-externally-dispatched. That entry's `when` predicate reads the
  // SAME imported ESC_CANCELABLE_DRAG_KINDS this listener does, so the bar cannot
  // go quiet on a gesture Escape really does cancel.
  $effect(() => {
    const onKeydownCapture = (e) => {
      if (e.key !== "Escape" || !ESC_CANCELABLE_DRAG_KINDS.includes(drag?.kind)) return;
      e.stopPropagation();
      cancelPointDrag();
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

  // BAND-SELECT MODIFIER TRACKING (add/subtract/invert). A band drag's verb must
  // follow the modifiers LIVE — including a press or release with the pointer
  // STANDING STILL, which pointer moves alone can never deliver (a keypress
  // fires no pointer event, so the preview would keep showing the old verb until
  // the mouse twitched). Plain window keydown/keyup/blur listeners, the SAME
  // shape as the A-key tracking above: no capture phase and no preventDefault
  // are needed because a bare Shift/Alt/Cmd/Ctrl keydown matches no registry
  // entry (core/shortcuts.js dispatch requires a non-modifier main key), so
  // there is nothing to pre-empt. Two deliberate differences from `aHeld`:
  // the record is $state (the preview repaints from it), and every handler
  // early-returns unless a band drag is live, so no other gesture — and no
  // idle keystroke — pays reactivity for it. Any key event refreshes the WHOLE
  // record from its own flags, so the specific key pressed never has to be
  // matched (a Shift keydown carries shiftKey:true, its keyup shiftKey:false) —
  // which is also why this needs no typing-in-a-field guard, unlike the A-key
  // tracking above: that matches a LETTER (so typing "a" would arm it), while
  // reading e.shiftKey/altKey/metaKey is correct no matter what has focus.
  // Blur resets, for the same reason aHeld does: an alt-tab mid-drag must not
  // leave a phantom modifier latched onto the release.
  $effect(() => {
    const sync = (e) => {
      if (drag?.kind !== "band") return;
      bandMods = modifiersOf(e);
      refreshBandPreview();
    };
    const onBlur = () => {
      if (drag?.kind !== "band") return;
      bandMods = NO_MODIFIERS;
      refreshBandPreview();
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", onBlur);
    };
  });

  // ── Overlay geometry (screen space) ────────────────────────────────────────

  let overlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; app.selection; app.selectionSet; app.anchorsVisible; app.showGhosts; sizeIndicators; bandRect; bandAddIds; bandRemoveIds; bandMods; modalCenter; app.crosshair; placeRect; placeLine; placePreview; mouseWorld;
    if (!actions || !containerEl) return { outlines: [], handles: [], anchors: [], guideSegs: [], endpoints: [], modifiers: [], sizeArrows: [], band: null, bandVerb: null, bandAddOutlines: [], bandRemoveOutlines: [], scalePivot: null, ghostOutlines: [], crosshairSegs: [], placeBox: null, placeSeg: null, placeChains: [], placeRects: [], placeDots: [], multiBoxOutline: null };
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
      // scale contribute — selectionAABB's own rule). Handles + a solid half-
      // opacity box outline (.multiselect-box) mark the group the drag resizes.
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
    //
    // Each carries the two flags the skin reads: `selected` (this handle is in the
    // INNER selection scope) and `hidden` (its list element's visibility is off, so
    // the outline draws straight past it — it still gets a handle, or it could never
    // be shown again).
    const chosenHandles = new Set(app.handleSelection);
    const modifiers = selectedIds.length === 1 && sel
      ? nodeModifierPoints(sel).map((m) => ({
        id: m.id,
        selected: chosenHandles.has(m.id),
        hidden: !m.active,
        // ADDITIVE handle aspects (core/derive.nodeModifierPoints): `shape` picks the
        // glyph (a paint-path bezier handle is a triangle, not the default square),
        // `stem` is the anchor a curve handle tethers to (a dashed GHOST line so its
        // ownership is visible), `hasElement` gates the point CONTEXT MENU to handles
        // that back a list element. All null/false for widgets that declare none.
        shape: m.shape,
        stem: m.stem ? actions.worldToScreen(m.stem.x, m.stem.y) : null,
        hasElement: !!m.element,
        ...actions.worldToScreen(m.x, m.y),
      }))
      : [];

    // In-progress rubber band: the box itself (world-axis-aligned, so two
    // corners suffice) + the two PREVIEW BUCKETS as separate outline lists, so
    // the template can skin "about to be ADDED" differently from "about to be
    // REMOVED". `bandVerb` rides along so the box itself can carry the verb as a
    // class (the crosshair `skin` precedent: state → class, styling in app.css).
    let band = null, verb = null, bandAddOutlines = [], bandRemoveOutlines = [];
    if (bandRect) {
      const a = actions.worldToScreen(bandRect.x, bandRect.y);
      const b = actions.worldToScreen(bandRect.x + bandRect.w, bandRect.y + bandRect.h);
      band = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      verb = bandVerb(bandMods);
      const addSet = new Set(bandAddIds);
      const removeSet = new Set(bandRemoveIds);
      bandAddOutlines = nodes.filter((n) => addSet.has(n.itemId)).map(outlineOf);
      bandRemoveOutlines = nodes.filter((n) => removeSet.has(n.itemId)).map(outlineOf);
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

    // MULTI-STEP creation preview: whatever the live creation mode's overlay()
    // returned, mapped to screen space here (the mode speaks WORLD only, like every
    // plugin). Three primitives, drawn in the SAME gray placement skin as placeBox
    // above so a multi-step placement reads as the same mechanism:
    //   chains — a polyline through a vertex list (+ its closing edge when closed):
    //            the committed chain plus the segment to the pointer
    //   rects  — every box a multi-box sequence has placed, plus the live one
    //   dots   — a marker per landed vertex; `hot` = clicking here closes the loop,
    //            which is what makes the affordance visible BEFORE the click
    let placeChains = [];
    let placeRects = [];
    let placeDots = [];
    if (placePreview) {
      const pt = (x, y) => actions.worldToScreen(x, y);
      placeChains = placePreview.chains
        .filter((c) => c.points.length >= 2)
        .map((c) => {
          const pts = c.points.map(([x, y]) => pt(x, y));
          const ring = c.closed ? [...pts, pts[0]] : pts;
          return ring.map((p) => `${p.x},${p.y}`).join(" ");
        });
      placeRects = placePreview.rects.map((r) => {
        const a = pt(r.x, r.y);
        const b = pt(r.x + r.w, r.y + r.h);
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      });
      placeDots = placePreview.dots.map((d) => ({ ...pt(d.x, d.y), hot: d.hot }));
    }

    return { outlines, handles, anchors, guideSegs, endpoints, modifiers, sizeArrows, band, bandVerb: verb, bandAddOutlines, bandRemoveOutlines, scalePivot, ghostOutlines, crosshairSegs, placeBox, placeSeg, placeChains, placeRects, placeDots, multiBoxOutline };
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
    // Rich text OR any widget that opted into the in-place editor via
    // `inlineTextEdit` (e.g. plaintext, edited in plain-string mode).
    return (n && (n.type === "text" || n.plugin?.inlineTextEdit)) ? n : null;
  });

  // WYSIWYG LATEX EDIT: the derived node of the latex item being edited (or null).
  // The LatexEditController mounts the MathLive field in this node's world pose.
  // Stays non-null through the `closing` crossfade (latexEditing still set) so the
  // field can fade out over the un-suppressed canvas render. Same reactive-deps
  // pattern as textEditNode.
  let latexEditNode = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; // reactive deps (match `overlay`)
    if (!app.latexEditing || !actions) return null;
    const n = app.nodes().find((nn) => nn.itemId === app.latexEditing.itemId);
    return (n && n.type === "latex") ? n : null;
  });

  // CODE EDIT: the derived node of the widget whose code property is being
  // edited (or null). The CodeEditController mounts the editor panel near this
  // node's screen pose. Stays non-null through the `closing` crossfade. Same
  // reactive-deps pattern as latexEditNode.
  let codeEditNode = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; // reactive deps (match `overlay`)
    if (!app.codeEditing || !actions) return null;
    return app.nodes().find((nn) => nn.itemId === app.codeEditing.itemId) ?? null;
  });

  // SELECTED HANDLES in world space, or [] — what the HandleToolbar hangs off.
  // Read through app.selectedHandles() (the ONE query, shared with the actions), so
  // the bar and the commands can never disagree about what is selected. Same
  // reactive-deps pattern as the edit-node deriveds; app.handleSelection is the
  // extra dep that opens and closes it.
  let selectedHandles = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; app.handleSelection; // reactive deps (match `overlay`)
    if (!actions) return [];
    return app.selectedHandles();
  });

  // FLOATING TOOLBAR: the derived node whose floating toolbar is open, or null.
  // Stays open only while its item is still selected AND still declares a
  // floatingToolbar (so a pick that retypes/purges it, or selecting elsewhere,
  // closes it). Same reactive-deps pattern as the edit-node deriveds.
  let floatingToolbarNode = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; // reactive deps (match `overlay`)
    if (floatingToolbarItemId == null || !actions) return null;
    const n = app.nodes().find((nn) => nn.itemId === floatingToolbarItemId);
    if (!n || !n.plugin.floatingToolbar || !app.selectedIds().includes(n.itemId)) return null;
    return n;
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
      <!-- VIDEO V6 (additive): ONE shared WebGPU external-texture canvas over the
           scene; transparent where no video. Stacked above .scene but below the
           .overlay SVG, and pointer-events:none, so all interaction still reaches
           the SVG below it. -->
      <VideoV6Overlay nodes={videoV6Nodes} view={videoV6View} deviceW={videoV6Device.w} deviceH={videoV6Device.h} />
      <!-- Per-widget WebGPU video canvases, composited by the browser OVER the
           Skia scene and UNDER the SVG selection overlay (video_v7). -->
      <VideoV7Overlay descs={videoV7Descs} />
      <!-- VIDEO V8 overlay: ONE canvas stacked directly over .scene (below the
           .overlay SVG chrome), transparent except where a V8 video plays. Its
           backend (WebGPU zero-copy / WebGL2 upload) is created async in an effect
           above; pointer-events:none so all input still reaches the SVG overlay. -->
      <canvas bind:this={videoV8El} class="video-v8-overlay"></canvas>
      {#if videoV8Error}
        <div class="gpu-error">Video V8 overlay init failed. {videoV8Error}</div>
      {/if}
      {#if gpuError}
        <!-- No render fallback by decree (manifest RENDER MODES DECISION) —
             the failure is loud and names itself. -->
        <div class="gpu-error">Renderer init failed — cannot render. {gpuError}</div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        class="overlay {modeCursorClass}"
        bind:this={overlayEl}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onpointerleave={onPointerLeave}
        ondblclick={onDblClick}
        onwheel={onWheel}
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
               SWEEP: multi-resize via handles). A SOLID half-opacity rectangle
               (.multiselect-box overrides .selection's dash) so it reads as one
               calm group frame; the 8 handles sit on it. -->
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
        <!-- MULTI-STEP CREATION preview (web/creationSteps.js): the boxes a
             multi-box sequence has placed plus its live one, the vertex CHAIN of a
             click-click-click placement plus its rubber band to the pointer, and a
             marker on each landed vertex. All three wear the same .place-rect gray
             so an accumulating placement reads as the same mechanism as a
             one-gesture one; a HOT vertex (clicking it closes the loop) is the one
             thing that stands out, since it changes what the next click does. -->
        {#each overlay.placeRects as r}
          <rect class="place-rect" x={r.x} y={r.y} width={r.w} height={r.h} />
        {/each}
        {#each overlay.placeChains as points}
          <polyline class="place-rect" {points} />
        {/each}
        {#each overlay.placeDots as d}
          <circle class="place-dot" class:place-dot-hot={d.hot} cx={d.x} cy={d.y} r={PLACE_DOT_R} />
        {/each}
        {#if overlay.band}
          <!-- The in-progress rubber band. The held-modifier VERB rides as a
               class (the crosshair `skin` precedent: state → class, all styling
               in app.css) so the box you are dragging itself announces whether
               a release adds, subtracts or inverts — the modifier's meaning is
               readable WITHOUT moving the pointer or reading the HintBar. The
               unmodified "replace" verb keeps the bare .band-rect look. -->
          <rect
            class="band-rect"
            class:band-verb-add={overlay.bandVerb === "add"}
            class:band-verb-subtract={overlay.bandVerb === "subtract"}
            class:band-verb-invert={overlay.bandVerb === "invert"}
            x={overlay.band.x} y={overlay.band.y} width={overlay.band.w} height={overlay.band.h}
          />
        {/if}
        <!-- Live band-select feedback, split by PENDING CHANGE: .band-add marks
             items a release would ADD to the selection, .band-remove items it
             would REMOVE (a subtract band, an invert band's already-selected
             half, or the plain band's replaced leftovers). Both carry the shared
             .band-candidate base so the two skins differ only in their override
             rule — one styling seam, not two. -->
        {#each overlay.bandAddOutlines as o}
          <polygon class="band-candidate band-add" points={o} />
        {/each}
        {#each overlay.bandRemoveOutlines as o}
          <polygon class="band-candidate band-remove" points={o} />
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
        <!-- GHOST STEM LINES (F.16): a thin dashed tether from a curve handle to its
             anchor, so which anchor a bezier handle belongs to is visible. Drawn
             BEFORE the handles so the glyphs sit on top. Only curve handles declare a
             `stem` (core/derive.nodeModifierPoints), so lines appear for curves only.
             Styled inline from --a-* tokens (constant SCREEN-px chrome, view-scale
             independent like every other handle glyph) rather than app.css, which the
             fleet's Inspector agent owns. -->
        {#each overlay.modifiers as m}
          {#if m.stem}
            <line
              class="handle-stem"
              x1={m.stem.x} y1={m.stem.y} x2={m.x} y2={m.y}
              style="stroke: var(--a-modifier); stroke-width: var(--a-handle-stroke); stroke-dasharray: var(--a-selection-dash); opacity: var(--a-anchor-opacity);"
            />
          {/if}
        {/each}
        {#each overlay.modifiers as m}
          <!-- MODIFIER POINTS (manifest ARCHITECTURE PLAN #1 — "the PPT
               yellow squares"): an anchor is a SQUARE (the default 8px footprint,
               like ResizeHandles); a widget may declare `shape: "triangle"` for a
               handle of a different ROLE (a paint-path bezier handle) so the two read
               apart. Both reuse the .modifier class (fill/rim/cursor + the .selected
               and .hidden-element state overrides), so a triangle handle theming and
               selection-skinning come for free.
               RIGHT-CLICK a handle that backs a list element (hasElement) opens the
               point CONTEXT MENU (F.18). -->
          {#if m.shape === "triangle"}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <polygon
              class="modifier"
              class:selected={m.selected}
              class:hidden-element={m.hidden}
              points={`${m.x},${m.y - 5} ${m.x + 5},${m.y + 4} ${m.x - 5},${m.y + 4}`}
              onpointerdown={(e) => startModifier(m.id, e)}
              oncontextmenu={(e) => openPointMenu(m, e)}
            />
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              class="modifier"
              class:selected={m.selected}
              class:hidden-element={m.hidden}
              x={m.x - 4} y={m.y - 4} width="8" height="8"
              onpointerdown={(e) => startModifier(m.id, e)}
              oncontextmenu={(e) => openPointMenu(m, e)}
            />
          {/if}
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
            <text x={ANCHOR_COPY_TIP_X} y={ANCHOR_COPY_LABEL_Y}>{hoverAnchor.label}</text>
            <!-- ANCHOR COPY CHIPS (task #41): only on a genuine anchor HOVER
                 (itemId/anchorId present; the endpoint-drag bind path sets a
                 label-only hoverAnchor and shows none). Each chip copies the
                 anchor's valid equation ref `<label>.x|y` (pointerdown, not the
                 svg's drag/select — hence stopPropagation). Interactive; the
                 rest of the overlay is pointer-events:none. -->
            {#if hoverAnchor.anchorId != null}
              {#each ["x", "y"] as coord, i (coord)}
                {@const chipX = ANCHOR_COPY_TIP_X + i * (ANCHOR_COPY_CHIP_W + ANCHOR_COPY_CHIP_GAP)}
                {@const copied = justCopiedAnchor?.itemId === hoverAnchor.itemId && justCopiedAnchor?.anchorId === hoverAnchor.anchorId && justCopiedAnchor?.coord === coord}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <g
                  class="anchor-copy-chip"
                  class:copied
                  onpointerdown={(e) => { e.stopPropagation(); e.preventDefault(); copyAnchorRef(coord); }}
                >
                  <!-- SVG-native accessible name + hover hint (no HTML Tooltip inside <svg>). -->
                  <title>{copied ? "Copied!" : `Copy ${hoverAnchor.label}.${coord} to clipboard`}</title>
                  <rect x={chipX} y={ANCHOR_COPY_CHIP_Y} width={ANCHOR_COPY_CHIP_W} height={ANCHOR_COPY_CHIP_H} />
                  <text x={chipX + ANCHOR_COPY_CHIP_W / 2} y={ANCHOR_COPY_CHIP_Y + ANCHOR_COPY_CHIP_H / 2}>{copied ? "✓" : `.${coord}`}</text>
                </g>
              {/each}
            {/if}
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
      {#if latexEditNode && actions}
        <!-- WYSIWYG LaTeX editor: a MathLive <math-field> DOM overlay at the
             widget's world pose. The canvas equation is suppressed (see paint())
             so the field is the only visible equation; commit re-typesets the
             canvas through the normal emit() path and this fades out. -->
        <LatexEditController
          {app}
          node={latexEditNode}
          worldToScreen={actions.worldToScreen}
          zoom={viewport.zoom}
        />
      {/if}
      {#if codeEditNode && actions}
        <!-- CODE editor: a monospace textarea + highlight overlay pinned over
             the widget. The canvas render is suppressed (see paint()) so nothing
             re-renders per keystroke; commit re-renders once and this fades. -->
        <CodeEditController
          {app}
          node={codeEditNode}
          worldToScreen={actions.worldToScreen}
          zoom={viewport.zoom}
        />
      {/if}
      {#if floatingToolbarNode && actions}
        <!-- GENERAL floating canvas toolbar (double-click a widget declaring
             floatingToolbar): a theme-following popover anchored above the
             widget. The cursor widget uses it for its visual cursor grid. -->
        <CanvasToolbar
          {app}
          node={floatingToolbarNode}
          worldToScreen={actions.worldToScreen}
          zoom={viewport.zoom}
        />
      {/if}
      {#if modeList && actions}
        <!-- A MODE'S PICK LIST — the second input path for a mode whose `onPick`
             cannot always reach its target on canvas (occluded, tiny, off-screen).
             The mode DECLARES it (`list(ctx)` → {label, pick, hover} or null when it
             has nothing to offer yet), so this mounts one surface for any mode that
             wants one and knows nothing about bentos. Both paths land in the mode's
             own write, which is what keeps them from drifting. -->
        <BentoTargetList
          {app}
          node={modeList.node}
          cellLabel={modeList.label}
          worldToScreen={actions.worldToScreen}
          onhover={modeList.hover}
          onpick={modeList.pick}
        />
      {/if}
      {#if selectedHandles.length && actions}
        <!-- The SELECTED-HANDLE tools (hide/show, purge, and any curve/subpath
             toggles the widget declares), on the same FloatingCanvasPanel shell as
             the widget toolbar above. Universal: it appears for any widget whose
             handles are list elements. -->
        <HandleToolbar {app} handles={selectedHandles} node={app.selectedNode()} worldToScreen={actions.worldToScreen} />
      {/if}
      {#if pointMenu}
        <!-- POINT CONTEXT MENU (F.18): a small menu at the right-clicked handle. Its
             entries are declared by the widget (curve/subpath toggles) plus Remove;
             a pick runs the entry and closes, an outside click / Escape closes. -->
        <ContextMenu x={pointMenu.x} y={pointMenu.y} entries={pointMenuEntries()} onclose={closePointMenu} />
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
