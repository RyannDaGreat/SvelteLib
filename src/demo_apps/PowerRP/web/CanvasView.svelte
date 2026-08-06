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
  import { pickNode, pickNodeStack, pointInNodeBox, nodeFeatures, nodeAnchors, nodeModifierPoints, modifierWrite, isGhostNode, cameraRect, worldTransform, groupMembership, snapExclusionSet, UNCONSTRAINED } from "../core/derive.js";
  // THE NODE-FLOW INTERACTION LAYER. core/wire_drag.js owns every decision the
  // gesture makes; this component owns only the events and the SVG that shows the
  // GHOST being dragged and the beads it may land on. `portColor` is the ONE
  // type→colour lookup, and the painter reads the same table for the committed
  // wires it now draws into the scene (WORKSTREAM BN) — so a wire in flight and
  // the wire that replaces it are the same colour by construction.
  // `deriveWires` IS DELIBERATELY NOT IMPORTED any more: the committed wires are
  // scene content (render_gpu/ports.sceneIR), and calling it here would rebuild a
  // second copy of them for a layer that no longer draws any.
  import { portColor } from "../core/nodeflow.js";
  import { KNOB_FOCUS_GAP } from "../core/node_chrome.js";
  import { KNOB_R, knobDragValue } from "../core/node_knobs.js";
  import { knobFocusUi, knobCursorFor, knobDialAt, knobStateKey, knobTurnRefusal, knobWritePairs } from "./knobFocus.js";
  // WORKSTREAM CB: the live press set (what the overlay lights) and the play
  // mode's teardown. The SET is core/ so the presenter shares it; the MODE is web/.
  import { pressNote, releaseAllPresses, releaseNote } from "../core/live_control.js";
  import { litKeyRects, releaseHeldKeys, removeKeyUp, resetKeyboardPlay, setNoteSink } from "./keyboardPlay.js";
  import { allPortBeads, beadAt, wireBezierPath, wireDragStart, wireDrop, wireTargets } from "../core/wire_drag.js";
  // THE AUDIO MIRROR (NF-BIND): the document reflected into the one synth engine.
  // ONE WAY ONLY — the engine never writes back, so the core invariant is untouched.
  // AudioOverlay draws the LIVE meter/spectrogram in screen space; AudioBadge is the
  // autoplay surface. See web/audioMirror.svelte.js for why both exist.
  import AudioOverlay from "./AudioOverlay.svelte";
  import AudioBadge from "./AudioBadge.svelte";
  import { fireLiveTrigger, mirrorAudioFrame, playLiveNote, releaseAllLiveNotes } from "./audioMirror.svelte.js";
  import { solveSnap, solveEdgeSnap, sizeMatches, axisLock, provenanceAnchorId, anchorSnapEquation, resizeEdgeEquation } from "../core/snap.js";
  import { clipLineToRect } from "../core/geometry.js";
  // THE HANDLE GLYPH BANK: core/ owns the VOCABULARY (which looks exist and what
  // each is for), this file owns the DRAWING. The split is why a plugin can name a
  // glyph without depending on the app shell.
  import { handleGlyph } from "../core/handle_glyphs.js";
  // The R modal types its angle in DEGREES and `rotation` stores RADIANS. The
  // conversion is NOT re-derived here: `PROPS.rotation.display` names the same
  // transform the Inspector's rotation dial uses (web/displayUnits.js), so the
  // modal and the field cannot disagree about what "45" means, and a future
  // change of storage unit moves both.
  import { PROPS } from "../core/properties.js";
  import { displayUnit } from "./displayUnits.js";
  import { worldViewRect, canSkipNode } from "../core/view.js";
  import { ESC_CANCELABLE_DRAG_KINDS } from "../core/shortcut_entries.js";
  // dedupeGroupSelection: the group invariant app.selectMany enforces at commit —
  // imported here so the LIVE band preview shows the same set the commit will
  // keep (see bandSelectionAt), never a superset the commit then filters.
  import { selectInBox, rectFromCorners, dedupeGroupSelection } from "../core/bandselect.js";
  import { sceneIR, resolvedBackgroundFill } from "../render_gpu/ports.js";
  import { preRasterizePdfPages } from "../render_gpu/pdf_display.js";
  // The MAP tile pre-pass, the PDF one's twin: it picks each map's tile DEPTH from
  // this view's device-px-per-world-unit and its tile LIST from the visible crop.
  // It must run HERE and not only in cameraFrame.js because this component
  // hand-assembles its own IR (the standing TODO in cameraFrame.js's header) — a
  // map would otherwise get no descriptor in the editor and fetch nothing.
  import { prepareMapTiles } from "../render_gpu/map_display.js";
  import { prepareScene3dViews } from "../render_gpu/scene3d_display.js";
  import { rect as rectCmd } from "../render_gpu/ir.js";
  import { SkiaSurface } from "../render_gpu/skia/browser_surface.js";
  import { bootDone, bootFailed } from "./bootProgress.js";
  import { cameraDither } from "../render_gpu/skia/dither_shader.js";
  import { cameraAntialias, antialiasCoverage } from "../render_gpu/skia/render_settings.js";
  import { onImageLoad } from "../render_gpu/gpu/image_registry.js";
  import { onSvgSourceLoad } from "../render_gpu/gpu/svg_source_registry.js";
  import { onTextAssetLoad } from "../render_gpu/gpu/text_asset_registry.js"; // CSV/JSON data assets a chart widget plots (core/plugin_assets.js assetText)
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
  // sampleSubpath: the morph engine's own subpath sampler, reused by the SELECTION
  // INK DASH (WORKSTREAM NN) to measure how much of a boxed widget's box its ink
  // actually fills. Reading the engine's sampler rather than writing a second one
  // keeps "where the ink is" a single answer — the same reason the ink dash traces
  // morphPaths instead of a chrome-only outline hook.
  import { sampleSubpath } from "../core/morph.js";
  // Extracted pure drag geometry (manifest UNDEFERRAL SWEEP: CanvasView
  // drag-machine extraction — PARTIAL: the stateless math; the stateful per-kind
  // handlers stay here). See web/canvas/dragKinds.js + tests/dragkinds_test.js.
  import { translationPairs, translationRecord, resizeAnchors, resizedBox, resizeStoredState, scaleMemberPairs, scalePairs, rotationPairs, groupResizeState, creationRect, geometryPairs, refusedCoordinates, deltaWithoutRefused, placementDragKind, PLACEMENT_GRAMMARS, PLACEMENT_DRAG_KINDS } from "./canvas/dragKinds.js";
  // R6-28 EQUATION LOCK. `equationPinning` is the per-ITEM projection that holds
  // every equation-bound coordinate still; it enters at the SAME `constrain`
  // parameter the modal axis lock uses, so there is one answer to "where may this
  // drag land" and not a second interaction layer. See dragConstraint below.
  // `equationLockNote` is the SENTENCE that condition explains itself with, and it
  // lives beside the query for the reason commandUnavailableReason lives in
  // core/commands.js: three canvas surfaces have to say it, so none of them may own
  // it (todo #240 — it used to be a local here, reachable from one caller).
  import { equationPinning, equationLockNote } from "./canvas/equationBinding.js";
  // diffState is no longer imported here: the two direct calls it had (the single
  // resize and the group resize) now go through canvas/dragKinds.js geometryPairs,
  // which is where the minimal delta and the constraint projection are one step.
  import { visibleLevels, ticksInRange } from "../../../lib/ticks.js";
  import { ASSET_DRAG_MIME, isProjectZip } from "./projectApi.js"; // asset-tile drop payload type + the one .zip-is-a-project rule (drop-handler region)
  import { assetDropKind } from "./pluginAssetLoader.js"; // what a dropped asset DOES: "widget" (*.plugin.js) | "media" | "none" — declared + bare-node tested
  import { assetKindForFile } from "./assetRef.js"; // ONE file classifier (MIME for media prefixes, extension table otherwise) — replaced a local MIME-only copy that refused OS-dropped PDFs
  import { reportAction, warnOnce } from "../core/report.js"; // a refused DROP is one user act — reportAction, never a deduped one. A refused POINTER LOCK is the opposite on both axes: repeated clicks, so deduped; and the gesture still works by a worse route, which is warnOnce's stated remit rather than reportOnce's
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

  /**
   * CLICK-THROUGH CYCLING STATE — where the last selecting click landed, what was
   * stacked under it, and how deep into that stack we currently are.
   *
   * User, 2026-08-01: "If I click an element and then I click it again and it's not
   * fast enough to be a double click, select the element under that, and then under
   * that … if I don't move the mouse, so that I can select objects that are under
   * things that I can't normally reach." An occluded object has no pointer route to
   * it at all otherwise — only the Inspector's item picker and the keyboard.
   *
   * THE RESET CONDITION IS MOVEMENT, NOT A TIMEOUT, because that is what he asked
   * for and it is also the better rule: a timeout would silently reset mid-thought
   * while you look at what you just selected. `sig` resets it too — if the stack
   * under the cursor changed, the index into it means nothing.
   */
  let clickCycle = { x: -1, y: -1, sig: "", index: 0 };

  /**
   * Query (reads the node list; mutates only this component's cycle state). The
   * node a pointer-down should act on: the topmost hit normally, or the next one
   * DOWN when this is a repeated slow click at the same point.
   *
   * "NOT FAST ENOUGH TO BE A DOUBLE CLICK" IS ANSWERED BY THE BROWSER, NOT BY A
   * THRESHOLD OF OURS — but NOT the way I first wrote it, and the measurement is
   * worth keeping because the wrong version looks obviously right. `MouseEvent
   * .detail` is the platform's own multi-click counter, applied with the OS's
   * double-click interval, so `detail === 1` on a repeat is precisely the user's
   * phrase. It is simply NOT AVAILABLE ON THE EVENT WE ARE ON: measured in this
   * app, a slow repeat gives `pointerdown:detail=0  mousedown:detail=1`, and a fast
   * double gives `pointerdown:detail=0  mousedown:detail=2`. PointerEvent carries
   * ZERO always, and `mousedown` — which does carry it — fires AFTER `pointerdown`,
   * so its count cannot be read in time to decide this click.
   *
   * SO THE CORRECTION MOVED TO WHERE THE ANSWER ACTUALLY EXISTS: this function
   * cycles unconditionally on a held-still repeat, and `onDblClick` — which only
   * runs when the browser has DECIDED a double-click happened, on the OS interval —
   * resets the index and re-aligns the selection to the top of the stack. The
   * second click of a fast pair therefore advances for the few milliseconds before
   * `dblclick` lands, and is put back. That is invisible (no paint happens between
   * them) and, more importantly, `onDblClick` does its OWN `pickNode`, so the
   * activation was never reading the cycled selection in the first place.
   *
   * WRAPS at the bottom of the stack rather than dead-ending: clicking past the
   * last one returns to the top, which is recoverable, where sticking is not.
   */
  function cycledHit(nodes, w, tol, e) {
    const stack = pickNodeStack(nodes, w.x, w.y, tol);
    // TELL THE HINT BAR. A shortcut that is not registered does not exist, and
    // click-through is a real input with no key to press — the bar is the only
    // place it can be announced. Published here because this is where the stack
    // is already known; recomputing it for the chip would be a second traversal
    // and a second chance to disagree with the gesture.
    app.clickThroughDepth = stack.length;
    if (stack.length === 0) { clickCycle = { x: -1, y: -1, sig: "", index: 0 }; return null; }
    const p = screenPoint(e);
    const sig = stack.map((n) => n.itemId).join(",");
    const heldStill = Math.hypot(p.x - clickCycle.x, p.y - clickCycle.y) <= CLICK_SLOP_PX;
    // Shift is multi-select's gesture; cycling under it would fight the toggle.
    const repeat = heldStill && sig === clickCycle.sig && !e.shiftKey;
    const index = repeat ? (clickCycle.index + 1) % stack.length : 0;
    clickCycle = { x: p.x, y: p.y, sig, index };
    return stack[index];
  }

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
  /**
   * THE DIAL UNDER THE POINTER, as the cursor name it asks for ("grab" /
   * "grabbing") or null — WORKSTREAM BX's second half.
   *
   * ── THE RULING (user, 2026-08-03, verbatim) ───────────────────────────────
   * "and if it showed the hand icon and then let the grabby hand icon when i move
   * the knobs" … "I mean like my mouse cursor".
   *
   * ── WHY IT IS $state AND NOT $derived, unlike modeCursorClass below ───────
   * A dial's cursor is a question about a POINTER POSITION against a HIT TEST, and
   * neither is reactive state: screenMouse is written per pointermove anyway, but
   * re-running pickNode + the layout for every dependency change would be a hit
   * test per repaint rather than per move. So the pointer handlers write it at the
   * one moment it can change — which is also the moment they already pay for the
   * lookup. `null` whenever the pointer leaves the canvas or a non-knob drag
   * starts, so a hand cannot outlive the thing it was pointing at.
   */
  let knobCursor = $state(null);
  /**
   * THE DIAL CURSOR CLASS — "" or `cursor-grab` / `cursor-grabbing`.
   *
   * SEPARATE FROM modeCursorClass, and both are applied, because they answer
   * different questions: that one is "what is this MODE for", this one is "what is
   * under the POINTER right now". CSS resolves the pair by specificity, and the
   * dial rule is written last in web/app.css so the concrete thing under the
   * pointer wins over the ambient mode — which is what you want, since a dial you
   * can actually grab is more specific information than the mode you are in.
   */
  let knobCursorClass = $derived(knobCursor ? `cursor-${knobCursor}` : "");
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
  // ── HANDLE IDENTITY: the hovered handle's LABEL ────────────────────────────
  // The id of the modifier point the pointer is currently over, or null. Its
  // `label` (declared per row — core/registry.js "HANDLE IDENTITY") is drawn as a
  // small tip beside the glyph, answering "what is this handle?" without a drag.
  //
  // IT RIDES THE GRAB GEOMETRY BY CONSTRUCTION, WHICH IS WHY IT IS AN ID AND NOT A
  // POINT. A modifier point is grabbed by `onpointerdown` ON ITS OWN SVG ELEMENT —
  // there is no distance test anywhere in startModifier, the hit region simply IS
  // the drawn glyph. So the hover binds pointerenter/pointerleave to that SAME
  // element and inherits that same region exactly: no radius is written down
  // twice, and changing a glyph's footprint moves both affordances together. (A
  // second, distance-based hover test — the shape hoverAnchor uses for anchors,
  // which are pointer-events:none marks with no element to hover — would have been
  // a second geometry free to disagree with the grab.)
  let hoverHandleId = $state(null);
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
  // ── HANDLE GLYPH GEOMETRY ───────────────────────────────────────────────────
  // The half-footprint every modifier glyph is drawn inside: the square is 8px
  // across, so 4. Every other outline in the bank is sized from this ONE number so
  // that swapping a handle's glyph never changes how big its grab target is — the
  // property that lets the hover tip reuse the drag's hit region verbatim, and the
  // reason muscle memory survives a widget adopting a new look. It is SCREEN px
  // (constant chrome, view-scale independent, like every other handle glyph).
  const HANDLE_R = 4;
  // The triangle is drawn 1px taller than the square's half-height and dropped 1px
  // low, which is the exact geometry paint_path's bezier handles have always had —
  // preserved to the pixel so the bank's arrival is invisible on existing widgets.
  const HANDLE_TRI_UP = 5, HANDLE_TRI_DOWN = 4, HANDLE_TRI_HALF_W = 5;

  /**
   * Pure function. The SVG outline points/attrs for one bank look at a screen
   * point. Returns a discriminated shape the template renders — {kind: "rect"} or
   * {kind: "poly", points} — so the template has ONE branch on `kind` rather than
   * one per bank entry, and adding a polygon glyph to the bank needs no template
   * change at all.
   *
   * Args:
   *   look ({shape}): a resolved bank look (core/handle_glyphs.handleGlyph)
   *   x, y (number): the handle's SCREEN position (its centre)
   *
   * Returns:
   *   {kind: "rect", x, y, w, h} | {kind: "poly", points: string}
   *
   * Examples:
   *   >>> glyphOutline({shape: "square"}, 100, 50)   // {kind: "rect", x: 96, y: 46, w: 8, h: 8}
   *   >>> glyphOutline({shape: "diamond"}, 0, 0)     // {kind: "poly", points: "0,-4 4,0 0,4 -4,0"}
   *   >>> glyphOutline({shape: "triangle"}, 0, 0)    // {kind: "poly", points: "0,-5 5,4 -5,4"}
   *   >>> glyphOutline({shape: "circle"}, 10, 10)    // {kind: "circle", cx: 10, cy: 10, r: 4}
   */
  function glyphOutline(look, x, y) {
    if (look.shape === "triangle") return { kind: "poly", points: `${x},${y - HANDLE_TRI_UP} ${x + HANDLE_TRI_HALF_W},${y + HANDLE_TRI_DOWN} ${x - HANDLE_TRI_HALF_W},${y + HANDLE_TRI_DOWN}` };
    if (look.shape === "diamond") return { kind: "poly", points: `${x},${y - HANDLE_R} ${x + HANDLE_R},${y} ${x},${y + HANDLE_R} ${x - HANDLE_R},${y}` };
    if (look.shape === "circle") return { kind: "circle", cx: x, cy: y, r: HANDLE_R };
    return { kind: "rect", x: x - HANDLE_R, y: y - HANDLE_R, w: HANDLE_R * 2, h: HANDLE_R * 2 };
  }
  // Baseline of the EQUATION-LOCK tip above a selected item's outline: far enough
  // clear of the dashed stroke to read, in the same screen-px chrome space every
  // other overlay glyph is measured in. Negative because the tip sits ABOVE the
  // box's top edge, where nothing else on the overlay draws.
  const LOCK_TIP_Y = -8;
  // Line spacing of the lock tip, screen px. The block grows UPWARD from LOCK_TIP_Y
  // (see the tspan dy below), so adding a line never pushes text over the widget.
  const LOCK_TIP_LINE_H = 14;
  /**
   * The EQUATION-LOCK tip's skin: the anchor tip's, declaration for declaration —
   * body text with a background-coloured halo behind it (paint-order: stroke) so a
   * sentence stays readable over arbitrary art, and pointer-transparent like every
   * other overlay mark.
   *
   * INLINE, AND ONLY BECAUSE web/app.css IS ANOTHER AGENT'S FILE THIS ROUND. The
   * right home is a `.overlay .lock-tip` rule sharing a selector list with
   * `.overlay .anchor-tip > text`, and that is filed as a hand-back. It is NOT
   * shipped as a bare class here: R6-28 did exactly that with ResizeHandles'
   * `.locked`, no rule ever landed, and the greying the user asked for silently
   * did nothing (tests/orphan_class_test.js red at HEAD). A visible duplicate
   * beats an invisible feature; an ORPHAN class is neither.
   */
  const LOCK_TIP_STYLE = "fill: var(--fg); font-size: var(--a-font-sm); paint-order: stroke; stroke: var(--bg); stroke-width: var(--a-text-halo-stroke); pointer-events: none;";
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
  // A TEXT DATA asset (a CSV a chart plots) arrives the same way and matters for
  // the same reason: the frame that requested it drew an empty chart.
  $effect(() => onTextAssetLoad(() => (imageEpoch += 1)));
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
  // {x, y} world — the PIVOT the gesture measures against (scale and rotate), or
  // null for grab, which has none. It is what draws the cursor→pivot line.
  let modalCenter = $state(null);
  // How far the cursor must start from the pivot for the gesture to have a
  // direction to measure. Below it, a scale's start distance is 0 (its ratio is
  // undefined) and a rotate's start ray has no heading (atan2(0,0) is a
  // convention, not an answer) — so both hold at identity until the cursor moves
  // away. Named because BOTH pivoted modals read it and it is a numerical bound
  // on a ratio and an angle, not a screen distance a user could ever notice.
  const MODAL_PIVOT_EPS = 1e-9;

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
        // THE boot splash is still covering the shell at this point (it lifts on
        // the first paint, which will now never come). Tell it, or the user gets
        // the gray box forever that this whole feature exists to kill.
        bootFailed(`Skia/WebGL init failed: ${gpuError}`);
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
    const doc = app.doc, slideIndex = app.slideIndex, registry = app.registry, project = app.projectName();
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
        project,
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
    // app.nodes() AND NOT A DERIVATION OF OUR OWN. It is the identical call — the
    // same evaluated state, registry and project — but it is MEMOIZED on that
    // state's identity, so the paint now shares one derivation with the two overlay
    // layers and every hit test in this file instead of adding a full pass over
    // every item to each frame. (Inlining it here is the same mistake the fold/blend
    // lines above already record: a private copy of a shared computation.)
    const allNodes = app.nodes();
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
    // until an unrelated repaint happened. "image_stack" is the SECOND widget built on
    // that op (plugins/image_stack.js — one videoV5Frame per stacked card), so it needs
    // the wake for the same reason and by the same mechanism.
    currentMediaRefs = videoSourcesOf(nodes, "video", "video_scrub", "video_v5", "video_v5_scrub", "filmstrip", "image_stack");
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
      // `live: true` — THIS surface repaints when an async raster lands (the
      // imageEpoch / onImageLoad wake above), so a widget mid-render may draw its
      // PREVIOUS frame instead of a transparent hole; the swap happens on the
      // repaint. It is the editor canvas that earns the flag, not the app: a
      // thumbnail or an export of the same scene captures once and must never be
      // handed a stale picture. render_gpu/ports.sceneIR states the contract.
      // scene3d: the viewport pre-pass (todo #257) — the resolution and the
      // sub-frustum a 3D scene renders at, both of which follow THIS canvas's
      // zoom and pan and so cannot be decided inside a camera-free emit().
      // `wireNodes` IS THE PRE-CULL TREE, and web/cameraFrame.js has passed it for
      // every other pixel consumer since WORKSTREAM BN — this call did not, so the
      // EDITOR alone derived its wires from the CULLED list and dropped a cable the
      // instant either end left the viewport. render_gpu/ports.js names that as one
      // of "the two wrong answers, both of which shipped at some point"; it was
      // still shipped here, in the one surface an author actually wires patches in.
      // The user's rule is "wires should only be culled if BOTH nodes are outside
      // view", and passing the pre-cull tree is how sceneIR knows which ends survived.
      ...sceneIR(nodes, {
        pdfDisplay,
        mapTiles: prepareMapTiles(nodes, view, canvasEl.width, canvasEl.height),
        scene3d: prepareScene3dViews(nodes, view, canvasEl.width, canvasEl.height),
        live: true,
        wireNodes: allNodes,
      }),
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
    // THE BOOT SPLASH LIFTS HERE — at the first REAL painted frame, never on a
    // timer. gpu.render above has just put pixels on the canvas, so there is
    // something behind the splash the instant it goes. Idempotent on the splash
    // side, so paying this call every frame costs one nullish check.
    bootDone();
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

  // NO LOCAL FILE CLASSIFIER. There was a `fileKind` here that read the MIME
  // PREFIX only, so an OS drag of a PDF answered "other" and the drop was
  // refused — the asset-tile bug's twin, one layer down, and it would have
  // survived the fix to the tile path untouched. web/assetRef.js
  // assetKindForFile is the one answer now: MIME for the three media prefixes a
  // browser is reliable about, the extension table for pdf/font/data, which it
  // already held.

  /** Command. Insert one asset ({name, kind, url}) centered at world point
   *  `at`. Kinds without a canvas widget are reported, never silently dropped. */
  async function insertDroppedAsset(asset, at) {
    // THE CLASSIFICATION IS DECLARED, not an if-chain: web/pluginAssetLoader.js
    // assetDropKind names the three outcomes and is bare-node testable (this file
    // is not). A `*.plugin.js` asset used to fall through the media branches into
    // the warning below — a correct message about the wrong classification.
    switch (assetDropKind(asset, app.registry)) {
      case "widget":
        // A WIDGET PLUGIN AS AN ASSET (user ruling: "If I drag and drop a widget
        // plugin onto the canvas, it should add the widget… from the asset
        // library"). ensure-loaded + place at the drop point honouring
        // placementAnchor — all three live in app.insertPluginAssetWidget.
        return app.insertPluginAssetWidget(asset, at);
      case "media":
        // ONE CALL FOR EVERY KIND. This was a ternary over image-vs-video, which
        // meant "media" could only ever mean those two even after the classifier
        // learned otherwise — so the PDF fix had to remove the branch, not extend
        // it. insertAssetWidget resolves the widget from the kind's claim.
        return app.insertAssetWidget(asset, at);
      default:
        // REPORTED, never a silently swallowed gesture. reportAction (not the
        // deduped reportOnce) because a refused drop is ONE user act — the same
        // rule the multi-zip refusal above follows.
        reportAction(`PowerRP: nothing on the canvas can show a "${asset.kind}" asset (${asset.name}) — it stays in the asset library.`);
    }
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
        await insertDroppedAsset({ name: up.name, kind: assetKindForFile(file), url: up.url }, at);
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
   *
   * `pointer` is null for a KEYBOARD activation (Enter — see activateNode below):
   * there is no cursor, and a handler that needs one must say so rather than read
   * a fabricated point. All six shipped handlers ignore it (they act on the NODE),
   * which is why Enter can reach every one of them.
   */
  function activationContext(hit, e) {
    const w = e ? worldPoint(e) : null;
    return {
      app,
      node: hit,
      plugin: hit.plugin,
      pointer: w ? { world: w, local: localPointOf(hit, w.x, w.y), screen: screenPoint(e) } : null,
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
    // A widget declaring NO activation leaves the rest of this handler with nothing
    // to do (a dblclick on a rect), so bail before the two side effects below —
    // activateNode re-resolves the same handler and is the one that runs it.
    if (!handlerFor("activate", hit.plugin)) return;
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
    // THE CLICK-THROUGH CYCLE'S CORRECTION POINT, and the only place the platform
    // will tell us a double-click happened. `cycledHit` cannot know — PointerEvent
    // carries detail 0 and `mousedown` fires after `pointerdown` — so the second
    // click of a fast pair advanced the cycle a few milliseconds ago. Put it back:
    // reset the index and align the selection with what is about to be ACTIVATED,
    // so double-clicking a stack edits its top item and leaves that item selected
    // rather than editing one object while a different one wears the outline.
    clickCycle = { ...clickCycle, index: 0 };
    activateNode(hit, e);
  }

  /**
   * Command. RUNS A NODE'S DECLARED ACTIVATION — the one entry point both ways in
   * reach it, so the double-click and the Enter key cannot drift into two
   * behaviours. Selects the node first (a widget you are about to edit must be the
   * one wearing the outline), then hands its handler the activation context.
   *
   * `e` is the originating MouseEvent for the pointer route and null for the
   * KEYBOARD route, which is the only difference between them — see
   * activationContext, whose `pointer` is null in the second case.
   *
   * The GATES are NOT here: they belong to each caller, because the two routes are
   * gated by different authorities. onDblClick states them as early returns (it is
   * raw DOM delivery); Enter states them ONCE, declaratively, in the registry's
   * `activatable` predicate — which is also what puts the chip on the HintBar, so
   * for the key route the gate and its announcement are one fact.
   */
  function activateNode(hit, e = null) {
    const handler = handlerFor("activate", hit.plugin);
    if (!handler) return;
    if (app.selection !== hit.itemId) app.selection = hit.itemId;
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
      const verdict = active.mode.onPick(modeContext(active), {
        node: pickNode(app.nodes(), w.x, w.y, SNAP_PX / viewport.zoom),
        world: w,
        local: localPointOf(active.node, w.x, w.y),
      });
      refreshModePreview(active);
      // ── A PICK MAY DECIDE THE PRESS IS A DRAG, AND THAT IS NOT A CONTRADICTION
      // OF THE PARAGRAPH ABOVE. "One press cannot both be consumed as a pick and
      // open a drag" is still true: what changed is WHO decides which it was.
      // For an eyedropper the answer is fixed and the mode never wants a drag.
      // For KNOB FOCUS (web/knobFocus.js) it is not: the same press is a wire
      // gesture on a bead, a turn on a dial, and an exit anywhere else, and only
      // the mode can tell those apart because only the mode knows where its
      // dials are. So `onPick` may RETURN "drag" to say "that press was mine and
      // it opens a pan", and the pan branch below runs for it.
      //
      // RETURNING NOTHING KEEPS THE OLD BEHAVIOUR EXACTLY — the two shipped pick
      // modes (bentoBind, lightPositionPin) return undefined and are unaffected.
      // Returning "release" says the opposite: the mode did NOT want this press,
      // so it falls through to the canvas's own machinery. Knob focus returns it
      // for a press on a PORT BEAD, which is how the always-active wire layer
      // keeps working inside the mode (the founding message's "even if it's not
      // selected", and the lesson wave 2's delete-gesture incident recorded).
      if (verdict === "release") return false;
      if (verdict !== "drag") return true;
    } else if (!active?.mode.onPan) return false;
    if (!active?.mode.onPan) return true;
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
    // A mode that declares `pointerLock` wants the POINTER ITSELF for the length
    // of the drag (web/sceneNav.js is the first). Requested HERE because a lock
    // needs a real user gesture and a pointerdown handler is one; released in
    // modePointerUp. setPointerCapture already routes the events, so this buys
    // the two things capture cannot: the travel stops being bounded by the window,
    // and the cursor stops sliding away from the thing it is steering.
    if (active.mode.pointerLock) requestModePointerLock(e.currentTarget);
    return true;
  }

  /** Command (async, fire-and-forget). Asks for the pointer, and REPORTS a refusal
   *  rather than leaving the user clicking at a widget that does not respond.
   *
   *  A REFUSAL IS EXPECTED, NOT EXCEPTIONAL, which is why this is caught at all:
   *  the API requires a transient user activation and a focused document, a
   *  sandboxed or cross-origin frame may forbid it outright, and a browser
   *  rate-limits a re-request made too soon after the user pressed Escape to
   *  leave — that last one is a deliberate anti-abuse rule and it fires during
   *  ordinary use. The mode stays fully usable when it happens: the drag path
   *  below falls back to plain client coordinates, which is exactly how this mode
   *  worked before pointer lock existed. So the failure costs a sentence, not the
   *  gesture.
   *
   *  Chrome returns a Promise here; older engines return undefined and signal
   *  failure through a `pointerlockerror` event instead — `await undefined`
   *  resolves, so the listener below is what covers those. */
  async function requestModePointerLock(el) {
    if (document.pointerLockElement === el) return;
    try {
      await el.requestPointerLock();
    } catch (e) {
      reportPointerLockRefusal(e instanceof Error ? e.message : String(e));
    }
  }

  /** Command. The ONE sentence a refused pointer lock produces, so the promise
   *  rejection and the legacy `pointerlockerror` event cannot grow two wordings
   *  for one condition.
   *
   *  warnOnce, NOT reportOnce, and core/report.js states the test verbatim:
   *  reportOnce says something is WRONG, warnOnce says "the app did the right
   *  thing by a worse route and the author should know". A refused capture is the
   *  second — the look still happens, bounded by the window and with the cursor
   *  visible. Deduped because a user who cannot get the lock will click again, and
   *  a line per click is the same flood by another name. */
  function reportPointerLockRefusal(why) {
    warnOnce(
      `canvas:pointerlock:${why}`,
      `PowerRP: this browser refused to capture the pointer for the canvas mode — ${why}. The gesture still works by dragging, but the pointer stays visible and the drag stops at the edge of the window. A refusal is normal right after pressing Escape to release a previous capture; click again in a moment.`
    );
  }

  /** Command. Pointer-move inside a live mode pan: hands the handler the pointer
   *  travel in the widget's LOCAL px frame (the frame its interior lives in), so a
   *  rotated or scaled widget pans along its own axes. */
  function modePointerMove(e) {
    const active = activeMode();
    if (!modeDrag || !active?.mode.onPan) return;
    // UNDER POINTER LOCK THE POINTER DOES NOT MOVE. clientX/clientY are frozen at
    // the position the lock was taken, so the two-point difference below yields
    // (0, 0) forever and the gesture silently does nothing — the exact shape of
    // failure this codebase forbids. The travel is `movementX/movementY` instead,
    // and it is converted through the SAME screenToWorld the frozen path uses so
    // one mapping law serves both: screenToWorld is affine, so a DIFFERENCE of two
    // screen points is origin-independent and the frozen origin does not matter.
    const s = screenPoint(e);
    const locked = document.pointerLockElement !== null;
    const fromWorld = locked ? actions.screenToWorld(s.x - e.movementX, s.y - e.movementY) : modeDrag.lastWorld;
    const toWorld = locked ? actions.screenToWorld(s.x, s.y) : worldPoint(e);
    const a = localPointOf(active.node, fromWorld.x, fromWorld.y);
    const b = localPointOf(active.node, toWorld.x, toWorld.y);
    // Only the UNLOCKED path advances the origin: locked, `lastWorld` is the point
    // the pointer was captured at and stays the anchor a released drag resumes
    // from, while each locked step is self-contained (its own from/to pair).
    if (!locked) modeDrag.lastWorld = toWorld;
    // `localX`/`localY` are the pointer's ABSOLUTE position in the widget's own
    // frame, alongside the per-move delta. A mode that integrates travel wants
    // the delta (interior pan, scene nav); a mode that measures FROM THE GRAB
    // wants the absolute point, and knob focus is the second kind for a stated
    // reason (core/node_knobs.knobDragValue: an accumulating gesture that clamps
    // at an end stop feels stuck when it reverses). `fine` is the held modifier,
    // read from the EVENT every move rather than frozen at the press, so
    // pressing Shift mid-turn takes effect — the same rule the band-select
    // modifiers follow.
    active.mode.onPan(modeContext(active), {
      dLocalX: b.x - a.x, dLocalY: b.y - a.y,
      localX: b.x, localY: b.y,
      fine: e.shiftKey,
    });
  }

  /** Command. Release ends the pan gesture (one undo unit) and gives the pointer
   *  back. The release is unconditional rather than gated on which mode took it:
   *  a lock this component did not request cannot exist (nothing else in the app
   *  calls requestPointerLock), and leaving one held after the gesture that owns
   *  it has ended would strand the user with an invisible cursor. */
  function modePointerUp() {
    if (!modeDrag) return;
    modeDrag = null;
    app.dragging = false;
    if (document.pointerLockElement) document.exitPointerLock();
    endModeGesture();
    // `onPanEnd` AFTER the commit, so a mode that reports what it landed on is
    // describing state the document actually holds. Optional like every other
    // mode hook — the three shipped pan modes declare none and are unaffected.
    const active = activeMode();
    if (active?.mode.onPanEnd) {
      active.mode.onPanEnd(modeContext(active));
      refreshModePreview(active);
    }
  }

  // A pending wheel-idle timer must not outlive the component: unmounting (entering
  // the presenter, closing the document) would otherwise let it commit into a doc
  // nobody is looking at any more. app.exitCanvasMode() commits whatever was staged
  // at the boundary itself, which is the honest place for it.
  //
  // NEITHER MAY A HELD POINTER. Unmounting mid-drag (the presenter opening on a
  // keystroke while a look gesture is live) would otherwise leave the document
  // with no cursor and no element left to release it — the one failure of this
  // feature a user could not talk their way out of.
  $effect(() => () => {
    if (modeZoomIdle !== null) clearTimeout(modeZoomIdle);
    if (document.pointerLockElement) document.exitPointerLock();
  });

  // THE LEGACY REFUSAL CHANNEL. Chrome rejects requestPointerLock's promise;
  // engines that predate that return undefined and fire this instead, so without
  // the listener a refusal there would be the silent failure the request path is
  // careful to avoid. Same sentence either way (reportPointerLockRefusal), because
  // one condition gets one voice.
  $effect(() => {
    const onError = () => reportPointerLockRefusal("the browser raised pointerlockerror");
    document.addEventListener("pointerlockerror", onError);
    return () => document.removeEventListener("pointerlockerror", onError);
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
        // The R modal adds its turn to this. `?? 0` because an absent rotation IS
        // rotation 0 — the same reading worldTransform uses — unlike an absent w,
        // which means the widget has no width at all (see rotationPairs).
        startRotation: n.state.rotation ?? 0,
      }));
  }

  /**
   * Query. THE PER-ITEM DRAG CONSTRAINT (R6-28 equation lock): the projection
   * every gesture hands to the seam for this item, or the protocol's own
   * UNCONSTRAINED identity when the lock is not armed.
   *
   * THIS IS THE ONE PLACE THE TOGGLE IS READ. `equationPinning` is a statement
   * about the DOCUMENT (which stored leaves are equations) and knows nothing
   * about the toolbar; asking `app.equationLock` here rather than inside it keeps
   * the projection testable with no app state in the picture, and keeps the
   * answer to "is the lock on" from being spread across the nine call sites that
   * need a constraint.
   *
   * IT COMPOSES RATHER THAN COMPETES. A gesture-level restriction (the modal X/Y
   * axis lock) and this per-item one are both `pinning`s, so the seam takes the
   * composition and the result is still the nearest allowed record — see
   * web/canvas/dragKinds.js bothConstraints for why that is a claim about
   * pinnings and not about projections in general.
   */
  function dragConstraint(itemId, plugin) {
    if (!app.equationLock) return UNCONSTRAINED;
    return equationPinning(app, itemId, plugin);
  }

  /** Query. dragConstraint for a drag MEMBER (translateMembers' record), which
   *  already carries both halves. A drag-all shares one delta across members that
   *  may be locked DIFFERENTLY, which is why the projection is per member rather
   *  than per gesture. */
  function memberConstraint(m) {
    return dragConstraint(m.itemId, m.plugin);
  }

  /** One local unit of trial travel for the affordance probe below. Any non-zero
   *  magnitude answers the question — "would this handle's drag be refused on
   *  this axis" is scale-free, because the projection either pins a coordinate or
   *  does not. One unit is the smallest value that cannot be mistaken for a
   *  no-op. */
  const AFFORDANCE_PROBE_UNITS = 1;

  /**
   * Query. WHAT A RESIZE HANDLE CAN STILL DO under the equation lock, as
   * `{lockedX, lockedY, lockNote}` — the per-DEGREE-OF-FREEDOM affordance.
   *
   * GREYING PER HANDLE WOULD BE WRONG. A corner drives both `w` and `h`; if only
   * the height is bound, that corner is NOT dead — it still resizes the width, and
   * drawing it disabled would read as a broken editor. So the answer is per axis,
   * and ResizeHandles turns a half-locked corner into a single-axis affordance
   * (its cursor becomes the one-axis cursor) rather than a disabled one.
   *
   * IT IS DERIVED BY RUNNING THE REAL GESTURE, not by a table. A trial drag of
   * this handle goes through the same `resizedBox` → `resizeStoredState` the live
   * drag uses, and whatever the projection refuses is what is locked. A
   * hand-written "the west edge moves x and w, the east edge moves w" mirror would
   * be a second statement of resize geometry and would rot against it the moment a
   * modifier or a rotation changed the coupling (ledger C-8). It also means the
   * indicator and the behaviour CANNOT disagree: both are the same call.
   *
   * ONE SOURCE OF "THIS COORDINATE WILL NOT MOVE", deliberately. An equation on
   * `h` already stops some paths writing it with the lock OFF (scaleMemberPairs
   * refuses a non-numeric `w`/`h`), and that asymmetry is a real, recorded
   * inconsistency (W3-A's F5) — but this indicator reports the LOCK and nothing
   * else, so it can never claim a restriction the lock is not imposing. When the
   * lock is off it returns nothing at all.
   */
  function resizeAffordance(node, handleId) {
    const lock = dragConstraint(node.itemId, node.plugin);
    if (lock === UNCONSTRAINED) return {};
    const start = { x: node.state.x ?? 0, y: node.state.y ?? 0, w: node.state.w ?? 0, h: node.state.h ?? 0 };
    const edges = { west: handleId.includes("l"), east: handleId.includes("r"), north: handleId.includes("t"), south: handleId.includes("b") };
    const rotated = (node.state.rotation ?? 0) !== 0;
    const probe = { x: AFFORDANCE_PROBE_UNITS, y: AFFORDANCE_PROBE_UNITS };
    const desired = resizeStoredState(resizedBox([0, 0, start.w, start.h], probe, edges, {}), node.world, rotated, start);
    const refused = refusedCoordinates(lock, start, desired);
    if (!refused.length) return {};
    return {
      lockedX: refused.some((k) => k === "x" || k === "w"),
      lockedY: refused.some((k) => k === "y" || k === "h"),
      lockNote: equationLockNote(refused, "resize"),
    };
  }

  /**
   * Query. WHAT A BODY DRAG CAN STILL DO under the equation lock, as
   * `{lockNote}` — or nothing at all when the drag is unrestricted.
   *
   * THE BODY IS THE THIRD SURFACE OF ONE CONDITION, and it was the silent one
   * (todo #240: "an equation-bound coordinate silently refuses a drag — no widget
   * says why"). A corner explained itself and a body drag did not, for no reason
   * anyone chose: `equationLockNote` had exactly one caller.
   *
   * IT ASKS THE REAL GESTURE, exactly as resizeAffordance does. `translationRecord`
   * (web/canvas/dragKinds.js) is the record `translationPairs` itself builds, so
   * this probe cannot disagree with the drag it describes — and it covers a moveBy
   * widget's endpoints as well as a bbox widget's x/y with no branch here.
   *
   * A TRIAL DRAG MOVES ON BOTH AXES, because the question is "what would this
   * gesture be refused", and a drag the user has not started yet has no direction.
   * A one-axis probe would answer "nothing is locked" for an item whose `y` is
   * bound, which is the exact case the user named first.
   *
   * NO PER-AXIS FLAGS, unlike a resize handle, and that is a fact about the
   * affordance rather than a simplification: the eight handles are eight separate
   * elements, so a half-locked corner can degrade to a one-axis cursor; the body
   * is ONE region whose drag stays useful as long as any axis survives. So the
   * body reports the sentence and nothing else, and a fully-locked item is still
   * only reported, never disabled — the drag simply has no degrees of freedom left.
   */
  function moveAffordance(node) {
    const lock = dragConstraint(node.itemId, node.plugin);
    if (lock === UNCONSTRAINED) return {};
    const raw = app.rawState().items ?? {};
    const member = { itemId: node.itemId, plugin: node.plugin, rawItem: raw[node.itemId], startX: node.state.x ?? 0, startY: node.state.y ?? 0 };
    const { start, desired } = translationRecord(member, AFFORDANCE_PROBE_UNITS, AFFORDANCE_PROBE_UNITS);
    const refused = refusedCoordinates(lock, start, desired);
    return refused.length ? { lockNote: equationLockNote(refused, "move") } : {};
  }

  /**
   * Query. WHAT A MODIFIER POINT CAN STILL DO under the equation lock, as
   * `{locked, lockNote}` — the yellow-square sibling of resizeAffordance.
   *
   * `mp` is a nodeModifierPoints entry, so it already carries the pair the
   * protocol is defined over (`constrain` then `apply`) and its x/y are WORLD;
   * the probe inverts through the same `node.world` modifierDrag inverts through,
   * which is why rotation and scale need no thought here.
   *
   * IT RUNS `modifierWrite`, THE REAL DRIVER, so the write set is the plugin's own
   * — the only way to know which parameters this handle touches, since a plugin's
   * `apply` is opaque and no table could name them. `drag.startState` for this
   * gesture IS `node.state` (see modifierDrag), so the start record here is the
   * one the live drag will compare against, not an approximation of it.
   *
   * `locked` MEANS "EVERY PARAMETER THIS HANDLE WRITES IS REFUSED" — the same
   * per-degree-of-freedom doctrine the corner follows, read in the handle's own
   * parameter space instead of in x/y. A handle that still writes something is
   * NOT drawn dead; it keeps its grab cursor and only carries the sentence.
   */
  function modifierAffordance(node, mp) {
    const lock = dragConstraint(node.itemId, node.plugin);
    if (lock === UNCONSTRAINED || !mp.apply) return {};
    const local = T.apply(T.invert(node.world), mp.x, mp.y);
    const written = modifierWrite(mp, node.state, { x: local.x + AFFORDANCE_PROBE_UNITS, y: local.y + AFFORDANCE_PROBE_UNITS });
    const keys = Object.keys(written);
    const start = Object.fromEntries(keys.map((key) => [key, node.state[key]]));
    const refused = refusedCoordinates(lock, start, written);
    if (!refused.length) return {};
    return { locked: refused.length === keys.length, lockNote: equationLockNote(refused, "drag this point") };
  }

  /**
   * Pure function. The inline style a modifier glyph wears when the lock has taken
   * everything it writes — `null` (no style at all) otherwise, so an unlocked
   * handle renders byte-identically to before.
   *
   * IT IS THE SAME TWO SIGNALS THE RESIZE HANDLE USES, said the same way: the
   * app-wide --a-disabled-opacity for "greyed", and `not-allowed` for the cursor.
   * A handle with SOME freedom left keeps its grab cursor and full opacity and
   * carries only the sentence, which is the per-degree-of-freedom doctrine read in
   * the handle's own parameter space.
   *
   * INLINE RATHER THAN A CLASS, deliberately, and R6-28 is the cautionary case: it
   * added a `.locked` class to ResizeHandles with no rule in web/app.css, so the
   * greying silently did nothing (tests/orphan_class_test.js was red at HEAD for
   * exactly that). The overlay's ghost stem lines a few lines below already style
   * themselves inline from --a-* tokens for the same reason.
   *
   * @param {{locked?: boolean}} m - an overlay modifier record
   * @returns {string|null}
   *
   * @example lockedGlyphStyle({locked: true}) // "opacity: var(--a-disabled-opacity); cursor: not-allowed;"
   * @example lockedGlyphStyle({locked: false}) // null
   * @example lockedGlyphStyle({}) // null (a widget with no lock in play declares nothing)
   */
  function lockedGlyphStyle(m) {
    return m.locked ? "opacity: var(--a-disabled-opacity); cursor: not-allowed;" : null;
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
    // ── THE PORT BEAD LAYER IS ALWAYS ACTIVE, AND IT WINS ────────────────────
    // The user's founding requirement, verbatim: "there are some things that would
    // normally look like handles but are actually not handles. Actually, these can
    // always be, EVEN IF IT'S NOT SELECTED, an area that if I click and drag it
    // from it, can click and drag to another node."
    //
    // So this is checked BEFORE selection, before the selected-object drag
    // priority, and before the topmost hit test — and it deliberately does NOT ask
    // whether the node is selected. Two consequences the placement encodes:
    //   IT BEATS BODY DRAG inside the bead radius (blueprint §6) and NOWHERE ELSE:
    //     `beadAt` returns null a few pixels away, so the very next line down —
    //     the ordinary pick — takes the press and the node moves as it always did.
    //   IT DOES NOT CHANGE THE SELECTION. Wiring two nodes is not selecting them;
    //     a gesture that stole the selection would make building a patch fight
    //     with whatever the Inspector was showing.
    if (startWireDrag(e, w)) return;
    // ── THE DIAL LAYER, CHECKED HERE FOR THE BEAD LAYER'S OWN REASON ─────────
    // "It would be nice if I didn't have to double click on the knobs to move
    // them" (user, 2026-08-03, WORKSTREAM BX) — which supersedes the founding
    // double-click phrasing. A dial is the same shape of affordance as a bead: a
    // small purposeful target on a module's face that you reach for directly. So
    // it resolves before selection and before the body drag, it does NOT ask
    // whether the node is selected, and it wins only inside the dial's own radius
    // — the very next line down takes the press a few pixels away, so there are no
    // dead pixels between turning a knob and moving the node.
    //
    // AFTER the bead, because core/node_knobs.knobAt rules that a wire gesture
    // outranks a dial wherever the two overlap (a knob has the Inspector as a
    // second route; a bead has none). BEFORE live-play, because the two never
    // compete on one widget — a Button/Keyboard face declares no dials — and the
    // dial's radius is the tighter claim of the two.
    if (startKnobTurn(e, w)) return;
    // ── THE LIVE-PLAY LAYER, CHECKED WHERE THE BEAD LAYER IS AND FOR THE SAME
    //    REASON ────────────────────────────────────────────────────────────────
    // "I need to be able to play with them myself" (user, 2026-08-03). A press on
    // a Button's face or a Keyboard's key is a PERFORMANCE, not an edit, so it is
    // resolved before selection and before the body drag — exactly like a port
    // bead, and with the same two consequences: it wins only inside the face's own
    // rect (a press on the card's header still moves the node), and it does NOT
    // change the selection, because playing a patch is not selecting it.
    if (startLivePlay(e, w)) return;
    // An armed CROSSHAIR (manifest ARCHITECTURE PLAN #5) consumes the
    // ONE-SHOT arm on the first pointer-down: "band" starts the rubber-band
    // drag kind below (mode already resolved at arm time — "regular" →
    // bandMode); "place" starts the placement drag kind. Both clear the arm
    // immediately (one-shot) so a second gesture needs a fresh arm/command.
    if (app.crosshair) {
      const armed = app.crosshair;
      // THE CREATE HANDLER IS RESOLVED ONCE, BEFORE THE ONE-SHOT CLEAR BELOW, and
      // it answers BOTH questions this press has to ask: whether a MULTI-STEP mode
      // takes over instead of a one-gesture placement (its arm survives the press —
      // see beginCreation), and, failing that, WHICH single-gesture grammar the drag
      // runs (placementDragKind). Resolving it twice is how the second answer came
      // to disagree with the first: the drag used to be announced as one kind for
      // both grammars while branching on `plugin.placement` for its geometry.
      // A RIG names its handler on the arm itself; a widget's comes from its plugin
      // declaration, exactly as placementUp resolves it.
      const create = armed.kind !== "place" ? null
        : armed.plugin ? handlerFor("create", armed.plugin) : getHandler("create", armed.handlerId);
      if (create?.mode) {
        beginCreation(create, armed, e);
        return;
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
        // THE DRAG KIND IS THE GRAMMAR (canvas/dragKinds.js placementDragKind): a
        // segment placement reads Shift as an axis lock and a box placement reads it
        // as a uniform scale, so they cannot share one kind without the HintBar
        // announcing one of them wrongly. Everything downstream — the preview shape,
        // the pointer routing, the commit, the chips — follows from this one value.
        drag = { kind: placementDragKind(create.id), plugin: armed.plugin, startWorld: { x: snappedStart.x, y: snappedStart.y }, startGuides: snappedStart.guides, lastWorld: w, downScreen: screenPoint(e), moved: false };
        // Seed the preview DEGENERATE at the start point, through the same grammar
        // every later move uses, so the first frame cannot draw a different overlay
        // from the second. Modifiers come from the DOWN event for the reason the
        // band's do one branch up — a placement armed by command and then
        // shift-dragged must honour Shift from frame one, not from the first keydown.
        previewPlacement(drag.startWorld, { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey });
        app.dragKind = drag.kind;
      }
      return;
    }
    const nodes = app.nodes();
    const tol = SNAP_PX / viewport.zoom;
    const hit = cycledHit(nodes, w, tol, e);
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
    // MOVING THE MOUSE ENDS THE CLICK-THROUGH OFFER, which is the user's own reset
    // condition ("if I don't move the mouse"). Retiring the chip here rather than
    // letting it linger keeps the bar honest: the next click at a new point starts
    // at the top of that point's stack, so an offer to "select underneath" would be
    // describing a gesture that is no longer available. Guarded on the value so a
    // mousemove over empty canvas does not write $state on every event.
    if (app.clickThroughDepth !== 0
        && Math.hypot(screenMouse.x - clickCycle.x, screenMouse.y - clickCycle.y) > CLICK_SLOP_PX)
      app.clickThroughDepth = 0;
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
      // THE HAND OVER A TURNABLE DIAL (WORKSTREAM BX). Asked once per bare
      // pointermove, off the SAME lookup the press uses, so the cursor promising a
      // turn and the press performing one are by construction the same decision.
      // knobCursorFor answers null for a BOUND knob: an `=` dial's press is
      // refused, and a hand over it would promise a turn the press declines.
      knobCursor = knobCursorFor(dialUnder(w)?.knob ?? null);
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
    else if (drag.kind === "wire") wireDragMove(w);
    else if (drag.kind === "liveplay") livePlayMove(w);
    else if (drag.kind === "knob") knobTurnDrag(e, w);
    else if (drag.kind === "band") bandDrag(w, e);
    // EVERY placement grammar routes here (PLACEMENT_DRAG_KINDS), so a grammar
    // added to the table is driven and committed with no edit to this dispatch.
    else if (PLACEMENT_DRAG_KINDS.includes(drag.kind)) placementDrag(e, w);
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
    const live = snapPoint(w.x, w.y);
    // The start point's guide (if it snapped at grab time) stays visible for
    // the WHOLE drag — its correction is fixed (drag.startGuides), only the
    // live point's guide is recomputed every move.
    guides = [...drag.startGuides, ...live.guides];
    previewPlacement(live, { uniform: e.shiftKey, symmetric: e.metaKey || e.ctrlKey });
  }

  /**
   * Command. Runs the drag's PLACEMENT GRAMMAR (canvas/dragKinds.js
   * PLACEMENT_GRAMMARS, chosen by drag.kind) for a live point and publishes the
   * result in the two places that need it: stashed on the drag record for the
   * commit, and mirrored into the SVG overlay.
   *
   * STASHING IS WHY THE COMMIT IS HONEST (the manifest pattern resizeDrag uses for
   * drag.lastBox): placementUp writes exactly the geometry that was last PREVIEWED,
   * rather than re-deriving it from a pointerup event that carries no modifier
   * state. Mutates `drag.lastRect` / `drag.lastEndpoint`, `placeRect`, `placeLine`.
   *
   * A grammar returns exactly ONE of `rect` / `endpoint` — the same union
   * `ctx.gesture` already hands the create handlers — so the absent one is a
   * DECLARED absence, not an unknown, and clearing it is what keeps a switched
   * grammar from leaving the other overlay drawn.
   *
   * @param {{x: number, y: number}} live - the SNAPPED world point under the cursor
   * @param {{uniform: boolean, symmetric: boolean}} mods - the live Shift/Cmd record
   */
  function previewPlacement(live, mods) {
    const start = drag.startWorld;
    const g = PLACEMENT_GRAMMARS[drag.kind].gesture(start.x, start.y, live.x, live.y, mods);
    drag.lastRect = g.rect ?? null;
    drag.lastEndpoint = g.endpoint ?? null;
    placeRect = g.rect ?? null;
    placeLine = g.endpoint
      ? { x1: g.endpoint.from.x, y1: g.endpoint.from.y, x2: g.endpoint.to.x, y2: g.endpoint.to.y }
      : null;
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
    app.setPreview(drag.members.flatMap((m) => translationPairs(m, dx, dy, memberConstraint(m))));
  }

  // ── Resize ──────────────────────────────────────────────────────────────────
  // resizeAnchors / resizedBox are imported from ./canvas/dragKinds.js.

  function startResize(handleId, e) {
    // ── THE BEAD LAYER WINS HERE TOO, AND THIS IS WHERE THE DELETE GESTURE WAS
    //    LOST (NF-BIND, 2026-08-02; measured, not reasoned) ────────────────────
    // The resize handles are their OWN SVG <rect>s with their OWN pointerdown
    // (ResizeHandles.svelte), so a press on one NEVER reaches onPointerDown — and
    // therefore never reaches the always-active bead check that lives there. The
    // handles only exist on the SELECTED node, and a node's west-middle handle
    // sits on its left edge, which is exactly where its INPUT beads are. So:
    //
    //   connect a wire into a node  →  that node becomes selected
    //   grab the input bead to drag the wire off  →  you grab `ml` instead
    //   the app starts a RESIZE, and the user's founding delete gesture dies
    //
    // Every CONNECT drag worked because it starts on an OUTPUT (right edge) of a
    // node that is not the freshly-selected one — which is why the gap looked like
    // "connected input beads specifically" rather than "beads under a handle".
    // Measured directly: the pointerdown's target was `rect.handle` and the drag
    // announced `dragKind: "resize"`.
    //
    // THE FIX IS THE RULING, NOT A SPECIAL CASE. The user's founding requirement is
    // that a bead is drag-active "even if it's not selected" — an affordance that
    // is always live cannot be one a DIFFERENT affordance covers up when the node
    // happens to be selected. So the bead check runs FIRST here for the same reason
    // it runs first in onPointerDown, calls the SAME startWireDrag, and yields to
    // the resize everywhere `beadAt` returns null (a few pixels away) exactly as it
    // yields to the body drag there.
    if (startWireDrag(e, worldPoint(e))) { e.stopPropagation(); return; }
    // AND THE DIAL LAYER WITH IT, for the identical reason one paragraph up. A
    // selected node draws its resize handles OVER its own face, so without this a
    // dial that sat under a handle would start a RESIZE — the same silent
    // half-gesture the bead suffered, one affordance over. BX made the dial
    // always-active; an always-active affordance that a selection covers up is
    // exactly the contradiction the bead's fix resolved.
    if (startKnobTurn(e, worldPoint(e))) { e.stopPropagation(); return; }
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
      // Carried for the R6-28 equation lock: isEquationValue needs the plugin's
      // own defaults to recognise a legacy BARE-STRING equation in a numeric
      // slot, and re-picking the node mid-drag would read a DIFFERENT selection
      // if one changed underneath the gesture.
      plugin: node.plugin,
      handleId,
      // An ARMATURE resizes by driving its own SIMILARITY `scale` (which members
      // inherit through applyGroupParenting), never w/h — so it needs its start
      // scale. Members follow with zero writes (manifest 15.7 GROUP RESIZE).
      // Read off the DECLARED capability, not `node.type === "group"`, per
      // core/registry.js: "tools/UI dispatch on these — NEVER on type". The same
      // declaration is what routes the S modal and the multi-resize
      // (dragKinds.scaleMemberPairs), so all three cannot disagree about which
      // widgets scale by their similarity.
      group: !!node.plugin.capabilities.armature,
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
    // A GROUP resize ANNOUNCES ITSELF AS ITS OWN KIND, because it reads only one
    // of resize's two modifiers (groupResizeState forces `uniform` on, so Shift
    // changes nothing — see DRAG_KIND_MODIFIERS.groupresize). `drag.kind` stays
    // "resize": that is the local dispatch key, and the group branch lives inside
    // resizeDrag. Two LITERAL assignments rather than one ternary, deliberately —
    // tests/shortcut_registry_test.js scans this file for a literal drag-kind
    // assignment, and a ternary would match neither, silently dropping both kinds
    // out of the guard. (That scan is also why this note names no example string:
    // it matched the placeholder in an earlier draft of this very comment.)
    if (drag.group) app.dragKind = "groupresize";
    else app.dragKind = "resize";
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
    // R6-28 EQUATION LOCK, GESTURE SPACE — the projection applied one space
    // EARLIER, before the box exists, and the reason it has to be is that a
    // resize computes its stored `x` and `w` JOINTLY from the grabbed edges.
    // Pinning only the locked leaf would leave the other one tracking the
    // cursor: `w` held with the WEST edge grabbed would SLIDE the widget rather
    // than refuse it. Zeroing the gesture's own delta on the refused axis is the
    // same `pinning`, in the parameterization where the two are still one number
    // — canvas/dragKinds.js deltaWithoutRefused states the equality, and the
    // record-space pin below still runs (idempotent) to catch anything no
    // gesture axis owns. The PROBE runs the real resizedBox, so what is tested
    // is the box this gesture would actually produce, modifiers and all.
    const lock = dragConstraint(drag.itemId, drag.plugin);
    const rawDelta = { x: local.x - drag.basePointer.x, y: local.y - drag.basePointer.y };
    const delta = lock === UNCONSTRAINED
      ? rawDelta
      : deltaWithoutRefused(rawDelta, refusedCoordinates(lock, s, resizeStateFor(resizedBox(drag.baseBox, rawDelta, edges, mods))));
    const box = resizedBox(drag.baseBox, delta, edges, mods);
    drag.lastBox = box;
    // ONE box → stored-state mapping (resizeStateFor), shared by the probe above
    // and the live path: the local origin shift for an unrotated item, the
    // centre-pivot back-solve for a rotated one.
    let { x, y, w: ww, h: hh } = resizeStateFor(box);

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

    // THE ONE GEOMETRY-WRITE SEAM (canvas/dragKinds.js geometryPairs): project
    // the desired box onto what the constraint allows, then commit ONLY the keys
    // that actually changed vs the resolved start pose (drag.startState) — an
    // east-only stretch writes just `w`, so a stored equation on x/y/h survives
    // untouched (interaction-commit rule). Grabbing an axis that DID move
    // overrides its equation with the literal, UNLESS the equation lock is armed,
    // which is the constraint this call now carries (R6-28). The comment here
    // used to say the resize handles pass none "so that a future one enters HERE
    // and nowhere else" — this is that future one, and it did.
    app.setPreview(geometryPairs(drag.itemId, s, { x, y, w: ww, h: hh }, lock));
  }

  /** Query (reads the drag record's frozen start pose). The stored {x, y, w, h} a
   *  resize BOX means — canvas/dragKinds.js resizeStoredState with this drag's
   *  world and start pose filled in. THE ROTATED-RESIZE PIVOT PIN and the
   *  unrotated origin shift both live there, in one place, because the equation
   *  lock's probe and the overlay's per-handle greying need the same mapping.
   *
   *  THE STEP ORDER IS UNCHANGED from when the back-solve was a separate block
   *  AFTER snapping, and it is safe to have merged them because snapping is
   *  skipped for exactly the rotated case the back-solve applies to. */
  function resizeStateFor(box) {
    return resizeStoredState(box, drag.world, drag.rotated, drag.startState);
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
    const rawLocal = { x: local.x - drag.basePointer.x, y: local.y - drag.basePointer.y };
    const start = { scale: drag.startScale, x: drag.startState.x, y: drag.startState.y };
    const lock = dragConstraint(drag.itemId, drag.plugin);
    // R6-28 EQUATION LOCK, GESTURE SPACE — and for an ARMATURE any refusal kills
    // the WHOLE gesture rather than one axis. That is not a special case, it is
    // the same sentence scaleMemberPairs' armature branch already writes: a
    // group's x/y are pure COMPENSATION for its `scale` (the back-solve that
    // keeps the grabbed anchor fixed), so with any one of the three held there is
    // nothing coherent for the other two to express. A zero delta gives K = 1,
    // which makes that fall out of the arithmetic — the group's scale, x and y
    // all come back at their start values and diffState drops all three.
    const dLocal = lock === UNCONSTRAINED || refusedCoordinates(lock, start, groupResizeWrites(rawLocal, edges, mods)).length === 0
      ? rawLocal
      : { x: 0, y: 0 };
    // Track lastBox so a modifier rebase (Cmd toggle) measures from the box on
    // screen — same bookkeeping the single-item path keeps (uniform forced).
    drag.lastBox = resizedBox(drag.baseBox, dLocal, edges, { ...mods, uniform: true });
    const gs = groupResizeWrites(dLocal, edges, mods);
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
    app.setPreview(geometryPairs(drag.itemId, start, gs, lock));
  }

  /** Query (reads the frozen drag record). The group's {scale, x, y} for a local
   *  pointer delta — groupResizeState with this drag's start pose filled in. ONE
   *  call, two callers: the equation-lock probe and the live path, exactly as
   *  resizeStateFor serves the single-item resize. */
  function groupResizeWrites(dLocal, edges, mods) {
    const gs = groupResizeState(
      { x: drag.startState.x, y: drag.startState.y, w: drag.startState.w, h: drag.startState.h, rotation: drag.world.rotation, scale: drag.startScale },
      drag.world, edges, mods, dLocal,
    );
    return { scale: gs.scale, x: gs.x, y: gs.y };
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
    app.setPreview(drag.members.flatMap((m) => scaleMemberPairs(m, kx, ky, ax, ay, memberConstraint(m))));
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
    // The RESOLVED start pose, FLATTENED to the dotted keys the geometry seam is
    // defined over ("from.x", not a nested {from: {x}}) — the same minimal-delta
    // basis modifierDrag freezes at grab, and what lets the equation lock name the
    // exact coordinate it refused. It must be the state at GRAB rather than the
    // live node.state for modifierDrag's reason: the live one already contains this
    // drag's own preview, so diffing against it would find nothing changed.
    const ep = node.state[which] ?? {};
    drag = {
      kind: "endpoint", itemId: node.itemId, which, plugin: node.plugin,
      startState: { [`${which}.x`]: ep.x, [`${which}.y`]: ep.y },
    };
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
    // THE SAME ONE SEAM every other drag writes through (geometryPairs). This
    // branch used to call setPreview with a hand-built path pair, and that is
    // exactly why R6-28's equation lock never reached it: five of the six drag
    // kinds ask dragConstraint and this one did not, so with the lock ON you could
    // still drag an endpoint whose coordinate was an `=` equation and replace it,
    // with no refusal and no cursor saying so.
    //
    // IT IS THE WORST GESTURE TO HAVE MISSED. This function is the one that WRITES
    // anchor bindings — the `@<id>_<anchor>.x` strings a few lines up. So the
    // single gesture capable of AUTHORING an equation was the single gesture that
    // could silently destroy one, which is how a user found it.
    //
    // Routing through the seam also brings the minimal delta: a purely horizontal
    // endpoint drag now writes x alone and leaves an equation on y untouched,
    // instead of rewriting both coordinates every frame.
    const written = { [`${drag.which}.x`]: xy.x, [`${drag.which}.y`]: xy.y };
    app.setPreview(geometryPairs(
      drag.itemId, drag.startState, written, dragConstraint(drag.itemId, drag.plugin)));
  }

  /**
   * Query (reads the document through `app`). The equation-lock affordance for one
   * ENDPOINT handle: `locked` when BOTH of its coordinates are refused, plus the
   * sentence saying which and why. `{}` when the lock is off or this endpoint is
   * free, so an unlocked canvas is untouched.
   *
   * PROBES BOTH AXES, for moveAffordance's reason: a one-axis probe would answer
   * "nothing is locked" for an endpoint whose `y` alone is bound. The probe values
   * must DIFFER from the start pose or refusedCoordinates correctly reports that
   * the gesture never moved the coordinate and so nothing was refused.
   *
   * This function did not exist, and its absence is the second half of the defect:
   * tests/equation_lock_test.js's divergence gate asserts that every affordance
   * function calls equationLockNote, but it can only check the functions that
   * EXIST — a gate over a roster cannot see an empty chair.
   */
  function endpointAffordance(node, which) {
    const lock = dragConstraint(node.itemId, node.plugin);
    if (lock === UNCONSTRAINED) return {};
    const keys = [`${which}.x`, `${which}.y`];
    const ep = node.state[which] ?? {};
    const start = { [keys[0]]: ep.x, [keys[1]]: ep.y };
    const refused = refusedCoordinates(lock, start, { [keys[0]]: ep.x + 1, [keys[1]]: ep.y + 1 });
    if (!refused.length) return {};
    return { locked: refused.length === keys.length, lockNote: equationLockNote(refused, "drag this point") };
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
      // The RESOLVED start state, frozen at grab — the minimal-delta basis every
      // other drag kind already carries (drag.startState / member.startX). It has
      // to be the state at GRAB and not the live node.state, because the live one
      // already contains this drag's own preview: diffing against it would find
      // nothing changed from the previous frame and clear the preview outright
      // (setPreview REPLACES wholesale), snapping the widget back.
      startState: node.state,
      plugin: node.plugin,
      startLocals, downScreen: screenPoint(e),
      // Shift on a handle means "toggle membership" — deferred to release exactly
      // like the item-level shift-click (onPointerUp's `drag.toggleId && !drag.moved`).
      toggleHandleId: e.shiftKey ? id : null,
    };
    app.dragging = true;
    app.dragKind = "modifier";
  }

  // ── THE WIRE GESTURE (core/wire_drag.js) ─────────────────────────────────────
  // The DECISIONS live in core (which bead a press grabs, what each target's
  // verdict is, what a release writes); this component owns only the pointer
  // events, the SVG and the undo call. Same split web/canvas/dragKinds.js made for
  // the bbox family, and for the same reason: rules inside a Svelte component
  // cannot be called from a test.

  /** The live wire drag: {anchor, detach} from core, plus the cursor world point
   *  and the per-bead verdicts recomputed on every move. null when no wire gesture
   *  is running, which is almost always. */
  let wireDrag = $state(null);

  /**
   * Query. Every port bead in the scene, WORLD space — recomputed per gesture
   * rather than kept in $derived state, because the population only matters while
   * a wire is being dragged or hit-tested and a per-frame derivation over every
   * node would cost the 99% of sessions that never touch a node.
   */
  function sceneBeads() {
    return allPortBeads(app.nodes());
  }

  /**
   * Command. Starts a wire gesture if `w` (a WORLD point) is on a port bead;
   * returns true when it consumed the press.
   *
   * THE GRAB RADIUS IS ZOOM-AWARE. The bead's LOCAL radius already scales with the
   * node, and `SNAP_PX / viewport.zoom` converts the pointer's screen-space slop to
   * world units — so the grab region tracks the picture at every zoom instead of
   * becoming unhittable when zoomed out and sloppy when zoomed in.
   */
  /**
   * Command. THE LIVE-PLAY GESTURE — a press on a Button's face or a Keyboard's
   * key. Returns whether it took the press.
   *
   * ── IT WRITES NOTHING TO THE DOCUMENT, AND THAT IS THE DESIGN ─────────────
   * A press is a MOMENT, and a moment is not a value any leaf could hold; storing
   * one would be the ephemeral state this project has none of (the full ruling is
   * in core/control_nodes.js). So this makes no preview, no commit and no undo
   * unit — playing a patch does not dirty the document, and Cmd+Z after a
   * performance undoes your last EDIT, which is what you want.
   *
   * ── ONE PRESS IS ONE EDGE ─────────────────────────────────────────────────
   * Fired here on pointer-DOWN and never again for the gesture: the engine's
   * trigger semantics are a rising edge, and a button that repeated while held
   * would be a clock (there is a Clock module for that).
   *
   * A KEYBOARD additionally holds its note until release, so it takes a drag —
   * which is also what makes a slide/glissando work: `livePlay` on pointermove
   * releases the old note and sounds the new one when the pointer crosses to
   * another key.
   */
  /**
   * Query. The dial under a WORLD point, as `{node, knob}`, or null — the
   * always-active dial layer's one lookup, shared by the press and the cursor so
   * the hand you see and the gesture you get can never disagree.
   *
   * THE GRAB RADIUS IS ZOOM-AWARE for startWireDrag's stated reason: `SNAP_PX /
   * viewport.zoom` converts the pointer's screen slop into the world units the
   * dial's own radius is expressed in.
   *
   * IT ASKS THE BEAD LAYER FIRST AND YIELDS TO IT. That ordering is the ruling
   * core/node_knobs.knobAt records: a knob has the Inspector as a second route
   * and a bead has none, so the wire gesture wins wherever the two overlap.
   */
  function dialUnder(w) {
    const nodes = app.nodes();
    const tol = SNAP_PX / viewport.zoom;
    const hit = pickNode(nodes, w.x, w.y, 0);
    if (!hit?.plugin?.knobLayout) return null;
    if (beadAt(allPortBeads(nodes), w.x, w.y, tol)) return null;
    const local = localPointOf(hit, w.x, w.y);
    const knob = knobDialAt(hit.plugin, hit.state, local.x, local.y, tol);
    return knob ? { node: hit, knob } : null;
  }

  /**
   * Command. THE ALWAYS-ACTIVE KNOB TURN (WORKSTREAM BX). Returns whether it took
   * the press.
   *
   * ── THE RULING (user, 2026-08-03, verbatim) ───────────────────────────────
   * "It would be nice if I didn't have to double click on the knobs to move them."
   * That SUPERSEDES the founding "if I double click the module, I can start
   * playing with the knobs in it": the user has now used the shipped mode and is
   * asking for the friction to go. Knob focus REMAINS — it is what paints the
   * focus ring and the live readout — but it is an affordance now, not a gate.
   *
   * ── IT SITS EXACTLY WHERE THE BEAD AND LIVE-PLAY LAYERS SIT, AND THAT IS THE
   *    WHOLE ARGUMENT ─────────────────────────────────────────────────────────
   * A dial is the third small, purposeful target on a module's face, and the two
   * that came before it resolved before selection and before the body drag for a
   * reason that applies verbatim here: you reach for it directly, so a selecting
   * click first would be friction with no purpose. So this inherits both of their
   * consequences unchanged — IT WINS ONLY INSIDE THE DIAL'S OWN RADIUS (a press a
   * few pixels away falls through to the ordinary pick and the node moves as it
   * always did, with no dead pixels between the two), and IT DOES NOT CHANGE THE
   * SELECTION, because turning a knob is not selecting the module any more than
   * wiring two nodes is.
   *
   * ── A BOUND KNOB IS REFUSED HERE, NOT FALLEN THROUGH ──────────────────────
   * knobTurnRefusal's sentence, the same one knob focus says, for the same reason
   * (web/interiorNav.js's ruling): turning would replace the equation with the
   * number it currently evaluates to. Consuming the press rather than returning
   * false is deliberate — falling through would MOVE THE NODE instead, which is a
   * different edit than the one the user asked for and a surprising one to undo.
   */
  function startKnobTurn(e, w) {
    const hit = dialUnder(w);
    if (!hit) return false;
    const refusal = knobTurnRefusal(hit.knob, app.displayName(hit.node.itemId));
    if (refusal) {
      reportAction(`PowerRP: ${refusal}`);
      return true;
    }
    overlayEl.setPointerCapture(e.pointerId);
    hoverAnchor = null;
    // THE HAND CLOSES for the whole gesture, and stays closed even as the pointer
    // travels off the dial — which it always does, because a turn is a vertical
    // drag and the dial is 26 local units across. A cursor that reverted mid-turn
    // would say the gesture had ended while it was still running.
    knobCursor = knobCursorFor(hit.knob, true);
    drag = {
      kind: "knob",
      itemId: hit.node.itemId,
      knob: hit.knob,
      stateKey: knobStateKey(hit.knob),
      startValue: hit.knob.value,
      startLocal: localPointOf(hit.node, w.x, w.y),
      world: hit.node.world,
      value: hit.knob.value,
    };
    app.dragging = true;
    app.dragKind = "knob";
    return true;
  }

  /**
   * Command. THE TURN. Stages one property write per move through setPreview, so
   * the host's single commitPreview on release makes the whole gesture ONE undo
   * unit — the same seam knob focus's own onPan uses, deliberately, so the two
   * entrances to the identical gesture cannot drift.
   *
   * The travel is measured from the GRAB rather than accumulated per event
   * (core/node_knobs.knobDragValue states why: an accumulating gesture that clamps
   * at an end stop feels stuck when it reverses), which is why this converts the
   * CURRENT world point into the node's local frame instead of reading a delta.
   */
  function knobTurnDrag(e, w) {
    if (drag?.kind !== "knob") return;
    const local = T.apply(T.invert(drag.world), w.x, w.y);
    const value = knobDragValue(drag.knob, drag.startValue, local.y - drag.startLocal.y, e.shiftKey);
    // NOTHING IS WRITTEN WHEN NOTHING CHANGED — a coarse-stepped knob sits on one
    // value across many pointermoves, and re-staging an identical preview per move
    // is pure invalidation. knobFocus.onPan guards the same way for the same reason.
    if (value === drag.value) return;
    drag.value = value;
    app.setPreview(knobWritePairs(drag.itemId, drag.stateKey, value));
  }

  /**
   * Query. WHAT A KNOB TURN CAN STILL DO under the equation lock — the LOCK_SURFACE
   * entry tests/equation_lock_test.js demands for the `knob` drag kind.
   *
   * A turn writes ONE plain numeric leaf, so unlike a resize handle there is no
   * per-degree-of-freedom story: the lock either holds that leaf or it does not.
   *
   * NOTE THE TWO INDEPENDENT REFUSALS, which is why this exists ALONGSIDE
   * knobTurnRefusal rather than replacing it. A knob whose own value is an `=`
   * equation is refused always (that is knob focus's ruling, and it holds with the
   * lock off). The EQUATION LOCK is the app-wide switch that additionally refuses
   * a drag writing any bound leaf. Both end at "the press will not turn this", and
   * the user is entitled to the sentence naming which rule stopped it.
   *
   * @param {object} node - the derived node carrying the dial
   * @param {object} knob - the knobLayout record under the pointer
   * @returns {{locked?: boolean, lockNote?: string}}
   */
  function knobTurnAffordance(node, knob) {
    const lock = dragConstraint(node.itemId, node.plugin);
    if (lock === UNCONSTRAINED) return {};
    const stateKey = knobStateKey(knob);
    const refused = refusedCoordinates(lock, { [stateKey]: node.state[stateKey] }, { [stateKey]: node.state[stateKey] + AFFORDANCE_PROBE_UNITS });
    if (!refused.length) return {};
    return { locked: true, lockNote: equationLockNote(refused, "turn this knob") };
  }

  function startLivePlay(e, w) {
    const hit = pickNode(app.nodes(), w.x, w.y, 0);
    if (!hit) return false;
    const press = hit.plugin.livePress;
    const play = hit.plugin.livePlay;
    if (!press && !play) return false;
    const local = localPointOf(hit, w.x, w.y);
    const items = app.state()?.items ?? {};
    if (press && press.hit(hit.state, local.x, local.y)) {
      fireLiveTrigger(items, app.registry, hit.itemId, press.port);
      // Capture the pointer even though there is nothing to drag: without it the
      // release lands wherever the pointer ended up and the canvas below can
      // start its own gesture from a press this one already consumed.
      overlayEl.setPointerCapture(e.pointerId);
      drag = { kind: "liveplay", itemId: hit.itemId, note: null };
      app.dragging = true;
      app.dragKind = "liveplay";
      return true;
    }
    if (play) {
      const note = play.noteAt(hit.state, local.x, local.y);
      if (!note) return false;
      // THE PICTURE AND THE SOUND, IN ONE STATEMENT (WORKSTREAM CB — user: "The
      // keyboard doesn't press keys visually when I touch it"). The press set is
      // what the overlay lights, and writing it HERE, next to the note that is
      // being played, is what makes "a key that sounds is a key that lights" true
      // by construction rather than by two call sites agreeing to stay in step.
      pressNote(hit.itemId, note.note);
      app.bumpPressEpoch();
      playLiveNote(items, app.registry, hit.itemId, "on", note.note, note.frequency);
      overlayEl.setPointerCapture(e.pointerId);
      drag = { kind: "liveplay", itemId: hit.itemId, note: note.note, plugin: hit.plugin, state: hit.state, world: hit.world };
      app.dragging = true;
      app.dragKind = "liveplay";
      return true;
    }
    return false;
  }

  /**
   * Command. A live-play drag moved — a GLISSANDO across a keyboard.
   *
   * Releases the held note and sounds the new one only when the pointer CROSSES
   * to a different key. Re-firing the same note on every pointermove would
   * retrigger its envelope dozens of times per second, which is a buzz rather
   * than a held note (and, on a poly module, would keep resetting one voice's
   * attack while the rest of the chord sustained).
   */
  function livePlayMove(w) {
    if (drag?.kind !== "liveplay" || drag.note === null) return;
    const local = T.apply(T.invert(drag.world), w.x, w.y);
    const next = drag.plugin.livePlay.noteAt(drag.state, local.x, local.y);
    const items = app.state()?.items ?? {};
    if (!next) return;
    if (next.note === drag.note) return;
    // The LIGHTS follow the glissando exactly as the sound does — released and
    // relit in the same statements, so a slide across the keys cannot leave a lit
    // key behind the pointer.
    releaseNote(drag.itemId, drag.note);
    pressNote(drag.itemId, next.note);
    app.bumpPressEpoch();
    playLiveNote(items, app.registry, drag.itemId, "off", drag.note, 0);
    playLiveNote(items, app.registry, drag.itemId, "on", next.note, next.frequency);
    drag = { ...drag, note: next.note };
  }

  /** Command. The live-play gesture ended: release a held note. A BUTTON has no
   *  note (its press was one edge at pointer-down), so this is a no-op for it. */
  function finishLivePlay() {
    if (drag?.kind !== "liveplay" || drag.note === null) return;
    releaseNote(drag.itemId, drag.note);
    app.bumpPressEpoch();
    playLiveNote(app.state()?.items ?? {}, app.registry, drag.itemId, "off", drag.note, 0);
  }

  function startWireDrag(e, w) {
    const beads = sceneBeads();
    if (beads.length === 0) return false; // no node widgets: nothing to grab, no cost
    const bead = beadAt(beads, w.x, w.y, SNAP_PX / viewport.zoom);
    if (!bead) return false;
    const items = app.rawState().items ?? {};
    const started = wireDragStart(items, bead);
    if (!started) return false;
    // CAPTURE ON THE OVERLAY, NOT ON `e.currentTarget`. This function has TWO
    // callers now: onPointerDown (where currentTarget IS the overlay) and
    // startResize (where it is the handle <rect>, a child element with no
    // pointermove/pointerup listeners of its own). Capturing on the rect would
    // route the rest of the gesture to an element that ignores it, so the ghost
    // wire would freeze at the press point and the release would never commit —
    // the same silent half-gesture the handle interception produced. `overlayEl`
    // is the element the move and up handlers are actually bound to, which makes
    // it the only correct capture target for either entrance.
    overlayEl.setPointerCapture(e.pointerId);
    hoverAnchor = null;
    // The anchor's world position is frozen at grab: the ghost is drawn from it to
    // the cursor, and the node it belongs to cannot move during a wire drag.
    const anchorBead = beads.find((b) => b.item === started.anchor.item && b.key === started.anchor.port);
    wireDrag = {
      ...started,
      anchorXY: anchorBead ? { x: anchorBead.x, y: anchorBead.y } : { x: w.x, y: w.y },
      cursor: { x: w.x, y: w.y },
      targets: wireTargets(items, app.registry, beads, started),
      hovered: null,
      beads,
    };
    drag = { kind: "wire" };
    app.dragging = true;
    app.dragKind = "wire";
    return true;
  }

  /** Command. Advances a live wire drag: moves the ghost's loose end and re-asks
   *  core for every bead's verdict, so the highlight the user sees is literally the
   *  decision the drop will make. */
  function wireDragMove(w) {
    if (!wireDrag) return;
    const target = beadAt(wireDrag.beads, w.x, w.y, SNAP_PX / viewport.zoom);
    wireDrag = {
      ...wireDrag,
      cursor: { x: w.x, y: w.y },
      // The hovered bead is only a TARGET when it is one of the drag's candidates
      // (the anchor itself is excluded by wireTargets), so hovering your own start
      // bead never lights up as a legal drop.
      hovered: target && wireDrag.targets.has(`${target.item}.${target.key}`) ? target : null,
    };
  }

  /**
   * Command. Ends a wire gesture. ONE UNDO UNIT via the universal
   * setPreview → commitPreview path — the same seam every drag commits through, so
   * a connect, a reroute and a disconnect are each one Cmd+Z, and a reroute's
   * clear-plus-write is ONE step rather than two.
   *
   * A REFUSED drop reports through the same channel a refused command does, rather
   * than failing silently: the user aimed at a bead and released, so something must
   * answer.
   */
  function finishWireDrag() {
    if (!wireDrag) return;
    const { pairs, refusal } = wireDrop(app.rawState().items ?? {}, app.registry, wireDrag, wireDrag.hovered);
    if (pairs.length) {
      app.setPreview(pairs);
      app.commitPreview();
    } else if (refusal) {
      // A REFUSED DROP IS ONE USER ACT, so it goes through reportAction and NOT the
      // deduped reportOnce — the identical refusal on a second attempt is a second
      // fact about a second gesture. That is the same reasoning (and the same call)
      // the refused asset drop above uses. The user has ALREADY been told visually:
      // the target bead dimmed the whole time it was under the pointer and the ghost
      // wire itself turned to the refusal colour before release. This line is the
      // WORDS behind that colour, for the case where "why not?" is the question.
      reportAction(`PowerRP: cannot connect — ${refusal}`);
    }
    wireDrag = null;
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
    // THE SAME ONE SEAM the bbox family writes through (geometryPairs), reached
    // with the record the yellow squares produce: `written` IS a flat stored-state
    // partial keyed by state key, which is exactly the coordinate record the
    // protocol is defined over — so this is not a second door, it is the same door
    // with a different key set. Two consequences, both deliberate:
    //   THE EQUATION LOCK REACHES THE YELLOW SQUARES (R6-28). A plugin's `apply`
    //     is opaque, so no projection in the handle's POINT space could express
    //     "this widget parameter is bound"; in the WRITE record it is one pinning,
    //     the same one every other gesture gets.
    //   THE MINIMAL DELTA NOW APPLIES HERE TOO, measured against the grab-time
    //     state (drag.startState). A handle in a multi-handle selection that did
    //     not move stops rewriting its parameter every frame, so an equation there
    //     survives — the same fix R6-29 made for the endpoint branch, and the
    //     `if (pairs.length)` guard that used to sit here is gone for the same
    //     reason moveDrag's did: a gesture returned exactly to its start must
    //     revert the preview, not freeze at the last non-zero one.
    const keys = Object.keys(written);
    const start = Object.fromEntries(keys.map((key) => [key, drag.startState[key]]));
    app.setPreview(geometryPairs(drag.itemId, start, written, dragConstraint(drag.itemId, drag.plugin)));
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
   * Query. The anchor ids item `itemId`'s plugin PUBLISHES right now — the
   * second argument core/snap.js provenanceAnchorId requires, because "which
   * anchors exist" is a question only the source plugin can answer (a bento grid
   * publishes 54 cell anchors; the hardcoded 15-name table it replaced declined
   * every one of them).
   *
   * BOTH CALLERS USED TO OMIT IT AND provenanceAnchorId THROWS ON THAT, so the
   * whole anchor-snap-to-equation release (holding A through a snapped move or
   * resize) died with a TypeError out of the pointerup handler. Nothing caught
   * it because tests/silent_promises_test.js exercises the pure function with
   * two arguments of its own making — a correct-by-construction imitation of a
   * call path that was wrong. tests/anchor_snap_release_test.js now drives THIS
   * function's contract instead.
   *
   * An item purged mid-drag publishes nothing, which provenanceAnchorId reads as
   * "not bindable" and the callers already handle by leaving the plain number —
   * the same partial-equation outcome the docs above describe, not a swallowed
   * failure.
   */
  function publishedAnchorIds(itemId) {
    const node = app.nodes().find((n) => n.itemId === itemId);
    return node ? nodeAnchors(node).map((a) => a.id) : [];
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
    const pairs = drag.members.flatMap((m) => translationPairs(m, drag.lastDx, drag.lastDy, memberConstraint(m)));
    const overrides = new Map(); // "x"|"y" → equation string, for drag.itemId only
    for (const p of prov) {
      const anchorId = provenanceAnchorId(p.sourceAnchorId, publishedAnchorIds(p.sourceItemId));
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
      const anchorId = provenanceAnchorId(p.sourceAnchorId, publishedAnchorIds(p.sourceItemId));
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
    // A cancelled WIRE gesture writes NOTHING — in particular it does not run
    // wireDrop, so a drag that picked up an existing connection leaves that
    // connection exactly where it was. Clearing the record is the whole cancel.
    wireDrag = null;
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
    // …and neither may the grab hand: a cursor is a claim about what the next
    // press does HERE, and the pointer is no longer here. Not cleared mid-turn —
    // the pointer is captured then, and the closed hand belongs to the gesture
    // rather than to whatever it happens to be over.
    if (drag?.kind !== "knob") knobCursor = null;
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
    // THE WIRE GESTURE COMMITS FIRST and returns: its release is decided entirely
    // by core/wire_drag.wireDrop (connect / reroute / disconnect / cancel /
    // refused), so none of the selection, click-vs-drag or preview machinery below
    // applies to it. It also writes NO selection — see the note at its pointer-down.
    if (drag.kind === "wire") {
      finishWireDrag();
      drag = null;
      app.dragging = false;
      app.dragKind = null;
      return;
    }
    // A LIVE PLAY RELEASES ITS NOTE AND RETURNS, for the same reason the wire
    // gesture does: it writes nothing to the document, so none of the selection,
    // click-vs-drag or preview machinery below applies to it.
    if (drag.kind === "liveplay") {
      finishLivePlay();
      drag = null;
      app.dragging = false;
      app.dragKind = null;
      return;
    }
    // A KNOB TURN COMMITS AND RETURNS. Every pointermove staged one setPreview, so
    // this single commitPreview closes the whole gesture as ONE undo unit —
    // idempotent when the turn never moved (commitPreview no-ops with nothing
    // staged), so a press-and-release on a dial adds no undo entry at all.
    //
    // IT RETURNS BEFORE THE SELECTION MACHINERY for startKnobTurn's stated reason:
    // turning a knob is not selecting the module, exactly as wiring is not.
    if (drag.kind === "knob") {
      app.commitPreview();
      // The hand REOPENS if the release landed back over a turnable dial and
      // reverts otherwise — asked through the same lookup rather than assumed, so
      // a turn that ended with the pointer off the module does not leave a hand
      // hovering over empty canvas.
      knobCursor = knobCursorFor(dialUnder(worldPoint(e))?.knob ?? null);
      drag = null;
      app.dragging = false;
      app.dragKind = null;
      return;
    }
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
    } else if (PLACEMENT_DRAG_KINDS.includes(drag.kind)) {
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
    // The handle-label hover is cleared here too, and cannot be left to
    // pointerleave: the overlay holds POINTER CAPTURE for the whole gesture, so a
    // drag that ends with the pointer far from the glyph never delivers a leave to
    // it, and a stale id would pop the tip back the instant `app.dragging` drops.
    // A pointer that really is still over a handle re-enters on its next move.
    hoverHandleId = null;
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
   * by the effect below when app.modalXform is set (the G/S/R shortcut). If the
   * cursor is off-canvas the start point falls back to the center, so a grab
   * begins at zero delta, a scale at factor 1 and a rotate at zero turn.
   *
   * `modalCenter` is set for the two PIVOTED kinds (scale and rotate) and not for
   * grab, which has no pivot — the selection simply follows the cursor. It is what
   * draws the cursor→pivot line (R6-2.2), so setting it for a kind that measures
   * nothing against a centre would draw a line about a fiction.
   */
  function beginModal(kind) {
    const nodes = app.nodes();
    const center = selectionCenter(app.selectedNodes());
    const members = translateMembers(nodes);
    if (!center || members.length === 0) { app.modalXform = null; return; } // nothing to transform
    const start = mouseWorld ?? center;
    modal = { kind, startWorld: start, members, center, axis: null, buffer: "" };
    modalCenter = kind === "grab" ? null : center;
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
   * guide and mirrors the state to the HintBar.
   *
   * ROTATE HAS NO AXIS, and that is geometry rather than an unbuilt feature:
   * Blender's `R X` picks one of THREE rotation axes, and the plane has exactly
   * one (the screen normal), so an X/Y constraint on a 2D turn has nothing to
   * choose between. The X/Y entries are gated off for rotate in
   * core/shortcut_entries.js so no chip offers it; this guard is the second half
   * of that — a key that cannot be announced must also not act if it arrives by
   * another route. */
  function modalSetAxis(axis) {
    if (modal.kind === "rotate") return;
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
      app.setPreview(modal.members.flatMap((m) => translationPairs(m, dx, dy, memberConstraint(m))));
    } else if (modal.kind === "rotate") {
      // ROTATE (R6-2.1): the turn is the ANGLE THE CURSOR HAS SWEPT about the
      // collective centre since the gesture began — the Blender reading, and the
      // one the cursor→pivot line makes literal on screen. A typed value is in
      // DEGREES, converted through the SAME display transform the Inspector's
      // rotation dial uses so the two cannot disagree about what "45" means.
      let angle;
      if (typed) angle = displayUnit(PROPS.rotation.display).fromDisplay(num);
      else {
        const w = modal.lastWorld ?? modal.startWorld;
        // Degenerate start (the cursor began ON the pivot) → no turn until it
        // moves away, the same guard the scale branch's zero start distance takes:
        // a ray from a point to itself has no direction to measure a sweep from.
        const d0 = Math.hypot(modal.startWorld.x - c.x, modal.startWorld.y - c.y);
        angle = d0 > MODAL_PIVOT_EPS
          ? Math.atan2(w.y - c.y, w.x - c.x) - Math.atan2(modal.startWorld.y - c.y, modal.startWorld.x - c.x)
          : 0;
      }
      app.setPreview(modal.members.flatMap((m) => rotationPairs(m, angle, c, memberConstraint(m))));
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
        factor = d0 > MODAL_PIVOT_EPS ? d1 / d0 : 1;
      }
      app.setPreview(modal.members.flatMap((m) => scalePairs(m, factor, c, modal.axis, memberConstraint(m))));
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
    // ENTER = DOUBLE-CLICK (user request, 2026-08-02: "if I hit the 'enter' key
    // wehn slecting a widget and we didn't double click it yet, treat that enter
    // key as a double click to go into editing it"). The hook lives here for the
    // same reason modalCommit and finishCanvasMode do: the ACTIVATION CONTEXT is
    // CanvasView's — `showOverlayPalette` writes a local, `enterMode` needs the
    // node — so this is the only place that can build one.
    //
    // It activates the PRIMARY selection (app.selectedNode()), which under a
    // multi-selection is `selectionSet[0]` — the same single item every other
    // single-select consumer reads (the Inspector's single-item UI, rename,
    // keyframe). Activating N widgets at once has no meaning anyway: five text
    // editors cannot hold the caret together.
    //
    // NO GATES HERE, deliberately: the registry entry's `activatable` predicate is
    // the gate, and App.svelte's onKeydown already refuses to dispatch while a
    // typing target, the palette or present mode owns the keyboard. Duplicating
    // them would be a second authority to keep in step with the HintBar.
    app.activateSelection = () => {
      const node = app.selectedNode();
      if (node) activateNode(node);
    };
    // Arrow-key NUDGE (one px per press, one undo unit): the same members and
    // the same translationPairs rule a body drag uses, so an arrow press and a
    // one-pixel drag are byte-identical writes (moveBy widgets move their free
    // coords; equation-bound axes that did not move stay equations).
    app.nudgeSelection = (dx, dy) => {
      const members = translateMembers(app.nodes());
      if (members.length === 0) return;
      app.setPreview(members.flatMap((m) => translationPairs(m, dx, dy, memberConstraint(m))));
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

  // "IS THIS BOX MOSTLY EMPTY?" — the test that decides whether a BOXED widget
  // takes the ink dash instead of its marquee (see wantsInkDash). Below this
  // fraction of the box's area, the ink is a thin run and the box is a large empty
  // frame around it, which is the paint_path case. Not a tuned constant: a stroked
  // open curve crossing a box corner-to-corner at a typical few-px width lands one
  // to two orders of magnitude under it, while anything drawing a filled region
  // lands far above — so the value sits in a wide gap rather than on a boundary.
  const INK_DASH_EMPTY_BOX_FRACTION = 0.15;
  // Points per curve when measuring that arc length. Enough to follow a cubic's
  // bend closely; the result feeds a coarse ratio test, not a rendered path.
  const INK_DASH_INK_SAMPLES = 8;

  /**
   * Query (reads the live viewport and the container's measured size). The WORLD
   * rect the SVG overlay is showing — THE cull rect for every per-node decoration,
   * and the clip rect the infinite guides are cut to.
   *
   * It is `core/view.worldViewRect`, the same function paint() culls with, so the
   * overlay cannot disagree with the picture about what is on screen. `dpr: 1`
   * because the SVG's coordinates are CSS pixels while the canvas's are device
   * pixels: paint() passes `canvasEl.width` (already multiplied by dpr) and the
   * real dpr, this passes the CSS size and 1, and the two produce the SAME world
   * rect by construction.
   *
   * `overlay` used to inline this arithmetic as a four-key object literal — a
   * second expression of a named concept, which is the drift this codebase keeps
   * paying for. Identical output: min() over a positive zoom is the (0,0) corner
   * and |x1 − x0| is width/zoom.
   */
  function overlayViewRect() {
    return worldViewRect({ ...viewport, dpr: 1 }, wrapW, wrapH);
  }

  let overlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; wrapW; wrapH; app.selection; app.selectionSet; app.anchorsVisible; app.showGhosts; sizeIndicators; bandRect; bandAddIds; bandRemoveIds; bandMods; modalCenter; app.crosshair; placeRect; placeLine; placePreview; mouseWorld;
    if (!actions || !containerEl) return { outlines: [], hoverOutlines: [], lockTips: [], handles: [], anchors: [], guideSegs: [], endpoints: [], modifiers: [], sizeArrows: [], band: null, bandVerb: null, bandAddOutlines: [], bandRemoveOutlines: [], modalPivotSeg: null, ghostOutlines: [], inkGhostOutlines: [], crosshairSegs: [], placeBox: null, placeSeg: null, placeChains: [], placeRects: [], placeDots: [], multiBoxOutline: null, inkDashes: [], bandAddInkDashes: [], bandRemoveInkDashes: [] };
    const rect = containerEl.getBoundingClientRect();
    const worldRect = overlayViewRect();
    const nodes = app.nodes();
    // THE DOCUMENT-WIDE DECORATIONS ARE CULLED (R7-6). Three of the lists below —
    // the anchor dots, the ghost outlines and the ink-bounds ghosts — are ONE DOM
    // ELEMENT PER NODE (per ANCHOR, for the first) over the whole document, so with
    // "show anchors" on, a deck with a thousand off-screen widgets emitted several
    // thousand SVG circles nobody could see and rebuilt them on every pan. The
    // selection-driven lists are deliberately NOT culled from: they are bounded by
    // what the author selected, and `nodes` still feeds the hit tests and the
    // editPoint `byId` map, where an off-view item is a legitimate reference.
    const visibleNodes = nodes.filter((n) => !canSkipNode(n, worldRect));
    const selectedIds = app.selectedIds();
    const sel = nodes.find((n) => n.itemId === app.selection);

    /** A LOCAL rect, mapped through a node's world transform into a screen-space
     * polygon points string. The shared corner math behind both `outlineOf` (the
     * property box) and the INK-BOUNDS ghost (a rect that is NOT the box), so the
     * two decorations cannot drift in how they project. */
    const rectOutlineOf = (n, r) =>
      [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([lx, ly]) => {
        const p = T.apply(n.world, lx, ly);
        const s = actions.worldToScreen(p.x, p.y);
        return `${s.x},${s.y}`;
      }).join(" ");

    /** A bbox node's screen-space outline polygon points string (its property box). */
    const outlineOf = (n) => rectOutlineOf(n, { x: 0, y: 0, w: n.state.w ?? 0, h: n.state.h ?? 0 });

    /**
     * THE SELECTION INK DASH (WORKSTREAM NN, rendering superseded by SS — user:
     * "selected arrows show nothing", then "that line could just go along the width
     * of the arrow", then, on NN's first rendering, "I was just hoping for a single
     * line, a single dashed line that connects the two points. Not whatever the fuck
     * that was"). A stroke widget's screen-space selection paths: the SAME thin
     * dashed hairline the box marquee draws, run ALONG THE INK instead of around a
     * box that does not describe it.
     *
     * ── WHY A BOX MARQUEE IS NOT MERELY UGLY HERE, IT IS ABSENT ────────────────
     * Two separate failures stack, and the second is the one the screenshot shows.
     * First, `outlines` above filters on `capabilities.bbox`, and the ENTIRE stroke
     * family is `bbox: false` — so a selected arrow got no outline at all; what the
     * user saw was the endpoint/modifier beads and nothing else. Second, even if it
     * had drawn one, the box IS the degenerate thing: a near-vertical arrow's ink
     * rect measures 26 × 324, so its marquee is a dashed hairline sliver that
     * reports none of the widget's 300px reach. Fixing only the filter would have
     * shipped the sliver; the ink dash is the answer to both.
     *
     * ── THE MECHANISM IS `morphPaths`, AND NOTHING NEW WAS DECLARED ────────────
     * Every stroke-family plugin ALREADY publishes its ink as cubic subpaths for
     * the morph engine (core/registry.js's `morphPaths` protocol), and that protocol
     * is bound by a stronger rule than we would have written for chrome: DERIVE THE
     * PAYLOAD FROM THE INK, NEVER ALONGSIDE IT — every provider reads the same
     * generator its own emit() draws with. So the ink dash traces exactly what the
     * widget paints, follows an elbow's jogs and a curved arrow's arc for free, and
     * a widget that changes its outline changes its ink dash with it. Declaring a
     * second per-plugin "selection outline" hook would have been a second geometry
     * pipeline entitled to disagree with the first, which is the failure mode that
     * protocol's own docblock exists to prevent.
     *
     * READ-ONLY: this calls the plugin hook and maps the result. It writes nothing,
     * registers nothing, and adds no declaration to any plugin file.
     *
     * ── THE RENDERING IS THE BOX MARQUEE'S, EXACTLY (WORKSTREAM SS) ───────────
     * NN's first cut INFLATED each subpath into a "corridor": a band as wide as the
     * painted stroke plus a clearance, floored at 9px. The user's screenshot of that
     * is what the SS ruling answers — a thick solid-looking blue casing coating the
     * arrow, fuzzy and fat, which is not the visual language the box marquee speaks.
     * The dash rhythm was there, but at 9-12px of stroke a `5 3` dasharray closes up
     * into a slab, and inflating in SCREEN px meant the slab grew fatter relative to
     * the art the further you zoomed in.
     *
     * SO THERE IS NO WIDTH HERE ANY MORE, AND THAT IS THE POINT. These paths carry
     * no inline stroke-width; `.selection-ink-dash` in app.css takes the identical
     * --a-selection colour, --a-selection-stroke weight and --a-selection-dash
     * rhythm as `.selection`, which is what makes a mixed selection of an arrow and
     * a rectangle read as ONE system. The only difference between the two marks is
     * the PATH — a rect's four corners versus the run the widget actually paints —
     * which was always the whole feature.
     *
     * NON-SCALING COMES FREE, by the same mechanism the box's does: this overlay is
     * an SVG in SCREEN coordinates (every point below goes through `worldToScreen`),
     * so a `stroke-width: 1.5px` from the stylesheet is literally 1.5 screen px at
     * every zoom, with no vector-effect and no per-frame recomputation. NN's width
     * was the one thing in the overlay that consulted `viewport.zoom`, and deleting
     * it is what makes the mark hold its weight.
     *
     * ── OPEN vs CLOSED SUBPATHS ARE THE TWO HALVES OF AN ARROW ────────────────
     * A payload's OPEN subpaths are centerlines (a shaft: the widget models two
     * endpoints and the run between them, and its width rides in `paint.strokeWidth`
     * because emit() hands a width to a polyline op and lets the painter expand it).
     * Its CLOSED subpaths are real silhouettes — an arrowhead glyph, a fancy_arrow's
     * whole outline. Under SS both are drawn the same way, as the hairline dash:
     * a centerline is a single dashed line down the middle of the shaft, and a
     * silhouette is a dashed OUTLINE of the head, never a fill. The distinction that
     * remains is only `fill: none` applying to closed subpaths too — the dash
     * outlines what is selected, it does not shade it.
     *
     * WHAT THIS MEANS FOR A CENTERLINE WIDGET, STATED PLAINLY: for line, arrow,
     * elbow_arrow, curved_arrow and paint_path the dash runs down the SHAFT, and the
     * arrowhead is outlined only where the plugin's payload includes a head contour
     * (arrow/curved_arrow/elbow_arrow do; a plain line has none to include).
     * fancy_arrow's payload is a single closed silhouette, so its dash traces the
     * head as part of the body. Where a head is not in the payload, the existing
     * endpoint beads still mark it — the dash plus those beads is the accepted
     * indication, not an oversight.
     *
     * ── SCREEN SPACE ──────────────────────────────────────────────────────────
     * Points map payload-local → world → screen through the SAME `worldToScreen`
     * every other overlay decoration uses.
     *
     * @param {object} n - a derived render node whose plugin declares morphPaths
     * @returns {Array<{d: string}>} SVG path data in screen px; empty when the
     *   widget has no ink to trace
     */
    const inkDashPathsOf = (n) => {
      // A widget that says it is not ready has nothing honest to trace (a
      // zero-span brace, a tangent pair with no tangent, an icon still fetching).
      // Same predicate the morph seam gates on, so the two cannot disagree about
      // whether geometry exists.
      if (n.plugin.morphNotReady?.(n.state)) return [];
      const payload = n.plugin.morphPaths(n.state);
      if (!payload?.subpaths?.length) return [];
      // The payload's frame. A boxless connector reports its INK RECT and its
      // coordinates are rect-relative (core/morph_payload.morphPayloadFromConnector),
      // so the rect origin has to be added back; a bbox widget like paint_path
      // reports its BOX, whose local origin is already (0,0) — reading localBounds
      // there would re-offset by the ink hull and slide the dash off the art.
      const origin = n.plugin.capabilities.bbox
        ? { x: 0, y: 0 }
        : (n.plugin.localBounds?.(n.state) ?? { x: 0, y: 0 });
      const toScreen = (lx, ly) => {
        const p = T.apply(n.world, (origin.x ?? 0) + lx, (origin.y ?? 0) + ly);
        return actions.worldToScreen(p.x, p.y);
      };
      return payload.subpaths.flatMap((sp) => {
        let pointCount = 1;
        const s0 = toScreen(sp.start[0], sp.start[1]);
        let d = `M${s0.x} ${s0.y}`;
        for (const c of sp.curves) {
          const c1 = toScreen(c[0], c[1]), c2 = toScreen(c[2], c[3]), e = toScreen(c[4], c[5]);
          d += `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${e.x} ${e.y}`;
          pointCount++;
        }
        if (sp.closed) d += "Z";
        if (pointCount < 2) return []; // a subpath with no run draws nothing
        return [{ d }];
      });
    };

    // EVERY selected bbox node gets a selection outline (multi-select
    // substrate). Resize handles: a SINGLE selection gets handles on its own
    // (rotation-aware) box; a MULTI selection gets handles on its COLLECTIVE
    // world AABB (manifest UNDEFERRAL SWEEP: "multi-resize via handles" — the
    // grabbed handle drags the collective box, members scale proportionally).
    const selSet = new Set(selectedIds);
    const selectedBboxNodes = nodes.filter((n) => selSet.has(n.itemId) && n.plugin.capabilities.bbox);

    /**
     * WHICH SELECTION INDICATION A WIDGET GETS (WORKSTREAM NN). A widget's box
     * dash is the right answer only when the box actually DESCRIBES it; for a
     * stroke widget it does not, so the ink dash replaces it.
     *
     * THE PREDICATE IS DERIVED, NOT A TYPE LIST, and it asks the question the
     * feature is actually about: DOES THIS WIDGET'S BOX DESCRIBE IT?
     *
     * BOXLESS ⟹ ALWAYS. The whole arrow family is `bbox: false` with no `w`/`h`
     * state at all, so there is no box to fall back on; `outlines` above skips them
     * entirely, which is why a selected arrow showed nothing. That covers line,
     * arrow, elbow_arrow, curved_arrow, fancy_arrow, brace and tangent_lines —
     * including fancy_arrow, whose payload is an all-CLOSED silhouette rather than
     * a centerline, and which an "has an open subpath" test would have missed.
     *
     * BOXED ⟹ ONLY WHEN THE BOX IS A BAD DESCRIPTION, measured against the ink it
     * publishes. A first cut of this admitted any boxed widget whose payload had an
     * OPEN subpath, and the AUDIT caught it over-reaching: plugins/svg.js is a
     * perfectly ordinary 160×160 boxed widget, but its DEFAULT artwork happens to
     * contain one open stroked subpath, so it would have lost its correct box
     * marquee because of a detail of the drawing inside it. Whether a box describes
     * a widget cannot depend on what art was loaded into it.
     *
     * So the real test is EMPTINESS: an ink dash is warranted when the ink occupies
     * a small fraction of the box's area, which is exactly the paint_path case — a
     * thin open curve inside a large rect, where the marquee is a big empty frame
     * around a stroke it barely touches. A filled shape, an image, a text box or a
     * fully-inked SVG all cover their box and keep the marquee.
     *
     * A NAMED TYPE LIST WOULD HAVE BEEN THE DEFECT GENERATOR the registry docblock
     * warns about under the universal-effects and gradient-handle rulings: the next
     * stroke widget anyone writes would be invisible when selected until someone
     * remembered to append it to a list no compiler asks for. Deriving from what the
     * plugin declares means a new stroke widget gets its ink dash for free.
     */
    const wantsInkDash = (n) => {
      if (!n.plugin.morphPaths) return false;
      if (!n.plugin.capabilities.bbox) return true; // no box to draw at all — the whole arrow family
      if (n.plugin.morphNotReady?.(n.state)) return false;
      const subpaths = n.plugin.morphPaths(n.state)?.subpaths ?? [];
      // Only an OPEN subpath can be a thin run — a closed one bounds an area, and a
      // widget that draws any filled region is described by its box well enough.
      if (!subpaths.length || subpaths.some((sp) => sp.closed)) return false;
      const boxW = Math.abs(n.state.w ?? 0), boxH = Math.abs(n.state.h ?? 0);
      if (!(boxW > 0 && boxH > 0)) return true; // a zero-area box describes nothing
      // THE INK'S OWN AREA vs THE BOX'S. A stroked open path covers roughly its
      // arc length times its width; comparing that to the box area asks "is this
      // box mostly empty?" without needing a second geometry pipeline to measure it.
      const ink = subpaths.reduce((acc, sp) => {
        const pts = sampleSubpath(sp, INK_DASH_INK_SAMPLES);
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        return acc + len * Math.max(sp.paint?.strokeWidth ?? 0, 1);
      }, 0);
      return ink / (boxW * boxH) < INK_DASH_EMPTY_BOX_FRACTION;
    };

    // THE TWO INDICATIONS ARE EXCLUSIVE per widget: an ink-dash widget does NOT also
    // get a box dash. Drawing both would put the degenerate sliver back on screen
    // next to the thing that replaced it, and for paint_path it would be the exact
    // pair of marks ("a big empty rect, and the curve") the ink dash exists to
    // reduce to one honest one.
    const inkDashNodes = selectedBboxNodes.filter(wantsInkDash);
    const inkDashSet = new Set(inkDashNodes.map((n) => n.itemId));
    const outlines = selectedBboxNodes.filter((n) => !inkDashSet.has(n.itemId)).map(outlineOf);
    // BOXLESS selected widgets never reached `selectedBboxNodes` at all — that
    // filter is why a selected arrow showed NOTHING, and this is the line that
    // restores them to the overlay. They are ink-dash-only by construction (no box).
    const selectedStrokeNodes = nodes.filter((n) => selSet.has(n.itemId) && !n.plugin.capabilities.bbox && wantsInkDash(n));
    const inkDashes = [...inkDashNodes, ...selectedStrokeNodes].flatMap(inkDashPathsOf);
    // THE AUDIT'S THIRD FINDING (WORKSTREAM NN). A boxless widget with a real ink
    // rect but NO `morphPaths` gets neither indication: no box to outline, no
    // payload to trace. plugins/demo/corkboard.js's `corkboardYarn` is the one such
    // widget in the tree — a sagging catenary cord that publishes `localBounds`
    // (368×212 at its defaults) but never joined the morph roster.
    //
    // ITS INK RECT IS THE HONEST FALLBACK, and it is deliberately NOT an ink dash:
    // the rect is a genuine, correctly-placed bound, so drawing it says something
    // true, whereas synthesizing a path through ink whose shape we have not been
    // told would be chrome inventing geometry — the exact "described alongside the
    // ink rather than derived from it" failure the ink dash was built to avoid.
    // It gets the ordinary `.selection` marquee, which is what this widget would
    // have had all along had it carried a box.
    //
    // THE REAL FIX IS ONE LINE IN THAT PLUGIN — a `morphPaths` declaring the same
    // quadratic its emit() already draws — at which point this branch stops
    // selecting it and it takes a curve-following ink dash like every other cord.
    // That line is not written here: plugins/ is outside this change's surface, and
    // the fallback means the widget is not invisible in the meantime.
    const inkRectOutlines = nodes
      .filter((n) => selSet.has(n.itemId) && !n.plugin.capabilities.bbox && !n.plugin.morphPaths && n.plugin.localBounds)
      .flatMap((n) => {
        const ink = n.plugin.localBounds(n.state);
        return ink && ink.w > 0 && ink.h > 0 ? [rectOutlineOf(n, ink)] : [];
      });
    // THE ITEM PICKER'S HOVER PREVIEW. Reuses `outlineOf` — the same geometry the
    // real selection outline uses — so a previewed box cannot disagree with the
    // box you get on release; only the SKIN differs (.selection-preview). Empty
    // whenever nothing is hovered, which is the overwhelmingly common case, and
    // suppressed while a drag is live so a stale hover cannot decorate a gesture.
    // An already-selected item previews nothing: it is already outlined, and a
    // second coincident polygon would just look like a rendering fault.
    const hoverNode = app.hoverItemId && !app.dragging
      ? nodes.find((n) => n.itemId === app.hoverItemId && n.plugin.capabilities.bbox && !selSet.has(n.itemId))
      : null;
    const hoverOutlines = hoverNode ? [outlineOf(hoverNode)] : [];
    // THE BODY DRAG'S REFUSAL, SAID ON THE CANVAS (todo #240). The selection
    // outline is `pointer-events: none` (app.css .overlay .selection) — as all
    // overlay decoration is, so a click reaches the item beneath it — so it cannot
    // host an SVG <title> the way a resize handle or a yellow square can: a hover
    // hint on a shape the pointer passes straight through would never appear. The
    // canvas's own answer to "say something here" is the anchor tip, an SVG <text>
    // with a halo (.overlay .anchor-tip > text), and this is that idiom reused.
    //
    // IT IS NOT NOISE, because it cannot appear unless the user armed the lock —
    // OFF by default, by his ruling — and the item he selected actually has a
    // coordinate the lock is holding. Both conditions are the affordance's own:
    // moveAffordance returns nothing at all otherwise.
    //
    // IT FLIPS ON THE CANVAS MIDLINE, which is how a long sentence stays on
    // screen without anyone estimating how wide it is. An item on the LEFT half
    // gets the tip anchored at its top-left and reading rightwards; an item on the
    // RIGHT half gets it anchored at its top-RIGHT and reading leftwards. A
    // measured width would be the alternative, and SVG can only give one AFTER
    // layout — too late for a derived value, and a per-character estimate would be
    // a magic number that is wrong for the first proportional font that changes.
    const lockTips = selectedBboxNodes.flatMap((n) => {
      const { lockNote } = moveAffordance(n);
      if (!lockNote) return [];
      const w = n.state.w ?? 0;
      const left = T.apply(n.world, 0, 0), right = T.apply(n.world, w, 0);
      const a = actions.worldToScreen(left.x, left.y), b = actions.worldToScreen(right.x, right.y);
      const pastMidline = a.x > rect.width / 2;
      // TWO LINES, SPLIT AT THE SENTENCE'S OWN EM DASH — a layout decision, not a
      // second wording: the string is the identical one the handles carry, and the
      // dash is exactly the clause boundary a line break replaces. Measured reason:
      // the whole sentence is ~110 characters and ran off the canvas at 1280px even
      // flipped, so a one-line tip was legible only for short property names. It is
      // also closer to the shape the user asked for — a "cannot move" line, then the
      // detail beneath it — than the single run it replaces.
      return [{ ...(pastMidline ? b : a), anchor: pastMidline ? "end" : "start", lines: lockNote.split(" — ") }];
    });
    let handles = [], endpoints = [], multiBoxOutline = null;
    if (selectedIds.length === 1 && sel?.plugin.capabilities.bbox && sel.plugin.capabilities.resizable) {
      const w = sel.state.w ?? 0, h = sel.state.h ?? 0;
      const hs = [["tl", 0, 0], ["tm", w / 2, 0], ["tr", w, 0], ["mr", w, h / 2], ["br", w, h], ["bm", w / 2, h], ["bl", 0, h], ["ml", 0, h / 2]];
      handles = hs.map(([id, lx, ly]) => {
        const p = T.apply(sel.world, lx, ly);
        return { id, ...actions.worldToScreen(p.x, p.y), ...resizeAffordance(sel, id) };
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
        endpoints.push({ which: p.key, ...actions.worldToScreen(p.x, p.y), ...endpointAffordance(sel, p.key) });
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
        // HANDLE IDENTITY (core/registry.js "HANDLE IDENTITY"): `glyph` is a key into
        // the BANK, resolved to a {shape, mark, accent} look HERE — once per handle
        // per overlay rebuild — so the template stays declarative and an unknown key
        // throws at the seam that introduced it rather than drawing a silent default.
        // The legacy `shape: "triangle"` is folded into the SAME lookup so the two
        // spellings cannot grow two pictures. `label` is the hover tooltip's words.
        look: handleGlyph(m.glyph ?? m.shape ?? null),
        label: m.label,
        stem: m.stem ? actions.worldToScreen(m.stem.x, m.stem.y) : null,
        hasElement: !!m.element,
        // {locked, lockNote} — the R6-28 affordance, per handle, and the second of
        // the three surfaces that speak the one refusal sentence (todo #240). A
        // yellow square could refuse in total silence before this: the lock reached
        // it through the seam, and nothing on the glyph said so.
        ...modifierAffordance(sel, m),
        ...actions.worldToScreen(m.x, m.y),
      }))
      : [];

    // In-progress rubber band: the box itself (world-axis-aligned, so two
    // corners suffice) + the two PREVIEW BUCKETS as separate outline lists, so
    // the template can skin "about to be ADDED" differently from "about to be
    // REMOVED". `bandVerb` rides along so the box itself can carry the verb as a
    // class (the crosshair `skin` precedent: state → class, styling in app.css).
    let band = null, verb = null, bandAddOutlines = [], bandRemoveOutlines = [], bandAddInkDashes = [], bandRemoveInkDashes = [];
    if (bandRect) {
      const a = actions.worldToScreen(bandRect.x, bandRect.y);
      const b = actions.worldToScreen(bandRect.x + bandRect.w, bandRect.y + bandRect.h);
      band = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      verb = bandVerb(bandMods);
      const addSet = new Set(bandAddIds);
      const removeSet = new Set(bandRemoveIds);
      // BAND PREVIEW SPEAKS THE SAME TWO GRAMMARS AS THE COMMITTED SELECTION
      // (WORKSTREAM NN). "About to be added" must be legible for an arrow for the
      // same reason "is selected" must be, and the answer has to be the same shape
      // or a band over a vertical arrow would preview an invisible sliver and then
      // commit to a visible ink dash. Same split, same predicate: box widgets get
      // the box, stroke widgets get their ink dash.
      const bandBucket = (idSet) => {
        const caught = nodes.filter((n) => idSet.has(n.itemId));
        return {
          outlines: caught.filter((n) => n.plugin.capabilities.bbox && !wantsInkDash(n)).map(outlineOf),
          inkDashes: caught.filter(wantsInkDash).flatMap(inkDashPathsOf),
        };
      };
      const add = bandBucket(addSet), remove = bandBucket(removeSet);
      bandAddOutlines = add.outlines;
      bandRemoveOutlines = remove.outlines;
      bandAddInkDashes = add.inkDashes;
      bandRemoveInkDashes = remove.inkDashes;
    }

    const anchors = (app.anchorsVisible ? visibleNodes : []).flatMap((n) =>
      nodeAnchors(n).map((a) => actions.worldToScreen(a.x, a.y)));

    // GHOST-OUTLINE (manifest ARCHITECTURE PLAN #2): widgets with no rendered
    // volume draw a thin outline so they stay selectable. Crop boxes show
    // ALWAYS (unclickable otherwise — the spec's "outline always visible in
    // the editor"); other ghosts (future: empty text, groups) only when the
    // "Show Ghosts" toggle is on. Editor-only chrome — never reaches sceneIR/
    // the GPU composite, so it never exports/presents.
    const ghostOutlines = visibleNodes
      .filter((n) => isGhostNode(n) && n.plugin.capabilities.bbox && (n.type === "cropbox" || app.showGhosts))
      .map(outlineOf);

    // INK-BOUNDS GHOST (user, 2026-08-02: "Physical boundaries when we enable
    // ghost mode, if they are different from property boundaries. Can display as
    // a ghost with a dashed line. And of course, they would be clickable").
    //
    // The rect a widget's INK actually occupies, drawn dashed whenever it DIFFERS
    // from the property box — which for text means "whenever the type overflows",
    // the exact condition that used to be invisible and is the whole reason the
    // box and the ink had silently disagreed. Identical rects draw nothing: a
    // second coincident polygon over every text box would be noise, and the
    // decoration is meant to answer "is this box lying about its contents".
    //
    // ALREADY CLICKABLE, with nothing added here: core/derive.clickableLocalRect
    // unions this same rect into the hit test, so the ghost DEPICTS a grab target
    // that exists rather than creating one. That is why this block is pure
    // chrome — editor-only, never in sceneIR, never exported or presented, like
    // every other overlay decoration.
    const inkGhostOutlines = app.showGhosts
      ? visibleNodes.flatMap((n) => {
          if (!n.plugin.capabilities.bbox || !n.plugin.localBounds) return [];
          const ink = n.plugin.localBounds(n.state);
          if (!ink || (ink.w <= 0 && ink.h <= 0)) return []; // nothing drawn: no ink to outline
          const box = { x: 0, y: 0, w: n.state.w ?? 0, h: n.state.h ?? 0 };
          const same = ink.x === box.x && ink.y === box.y && ink.w === box.w && ink.h === box.h;
          return same ? [] : [rectOutlineOf(n, ink)];
        })
      : [];

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

    // THE CURSOR→PIVOT LINE (R6-2.2), on BOTH the R and S modals: the red dashed
    // segment from the cursor to the collective centre, which is Blender's visual
    // proof of what the gesture is measuring — a rotation's swept ray, a scale's
    // distance ratio. It REPLACES the bare pivot dot that used to mark the same
    // point for scale alone ("the dot becomes a line"), and it is drawn through
    // the SAME world→screen mapping as every other overlay decoration rather than
    // a second geometry path. Null when there is no pivot (grab) or no cursor.
    const modalPivotSeg = modalCenter && mouseWorld
      ? (() => {
          const a = actions.worldToScreen(mouseWorld.x, mouseWorld.y);
          const b = actions.worldToScreen(modalCenter.x, modalCenter.y);
          return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        })()
      : null;

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

    return { outlines: [...outlines, ...inkRectOutlines], hoverOutlines, lockTips, handles, anchors, guideSegs, endpoints, modifiers, sizeArrows, band, bandVerb: verb, bandAddOutlines, bandRemoveOutlines, modalPivotSeg, ghostOutlines, inkGhostOutlines, crosshairSegs, placeBox, placeSeg, placeChains, placeRects, placeDots, multiBoxOutline, inkDashes, bandAddInkDashes, bandRemoveInkDashes };
  });

  /**
   * THE NODE-FLOW INTERACTION OVERLAY: the beads' hit/highlight layer, the live
   * ghost wire, and the knob focus ring. Its OWN $derived rather than another
   * dozen keys on `overlay`, for two reasons that are really one — it is the only
   * overlay layer that exists for a MINORITY of documents, and every one of its
   * lists is empty when no widget declares a port, so a document with no nodes
   * pays one `allPortBeads([])` per rebuild and allocates nothing.
   *
   * IT NO LONGER CARRIES THE COMMITTED WIRES (WORKSTREAM BN, 2026-08-03). Those
   * are SCENE content now — render_gpu/ports.sceneIR emits them under the nodes —
   * because the user asked for wires "in prsentation mode and pdf rener and png
   * render etc too", and an overlay path exists in this component alone. Deriving
   * them here as well would be a second drawing of one wire: a double-draw that
   * darkens every wire in the editor and nowhere else, and an editor that has
   * quietly stopped being a preview of what an export produces. So `deriveWires`
   * is not called here at all — the SVG below is the ghost and the beads only.
   *
   * WIRES ARE NOT WIDGETS is unchanged by that move: the scene emission creates no
   * item, none of it is selectable, and nothing reaches the widget library.
   *
   * SCREEN SPACE, like the rest of the overlay: the SVG is in screen coordinates,
   * so every world point goes through `worldToScreen` exactly once, here.
   *
   * ── IT IS CULLED, BY THE SAME PROTOCOL THE PAINT USES (R7-6) ────────────────
   * Every list below draws something AT a node — a hit target on its port, a ring
   * on its dial, a wash over its card — so a node the paint skipped contributes
   * nothing to any of them. Un-culled, this emitted one SVG <circle> per PORT of
   * every node in the DOCUMENT and rebuilt the lot on every viewport change:
   * measured at 3006 circles for a 1000-node patch parked entirely off-view, none
   * of them on screen, which is the DOM half of the user's "laggy when there are
   * tons of objects, even if they're out of view".
   *
   * ONE CULLING PROTOCOL, NOT A SECOND ONE: `canSkipNode` against `worldViewRect`,
   * the pair paint() filters on, so the overlay and the picture can never disagree
   * about what is on screen. The rect is built at dpr 1 because THIS surface is the
   * SVG, whose coordinates are CSS pixels — the paint passes device pixels and its
   * own dpr, and the two rects are the same world rect by construction.
   *
   * THE WIRES ARE NOT AT RISK FROM THIS, and that is worth stating because it is
   * the one thing culling an endpoint list could break. They are scene content now
   * (render_gpu/ports.sceneIR), derived from `wireNodes` — the PRE-CULL tree paint()
   * hands it — so a cable into an off-view node keeps both of its ends. Nothing
   * downstream of here reads these beads for geometry: the wire GESTURE takes its
   * anchors from sceneBeads(), which is deliberately un-culled.
   */
  let nodeOverlay = $derived.by(() => {
    app.doc; app.previewDelta; app.slideIndex; viewport; wrapW; wrapH; // reactive deps (match `overlay`, plus the cull rect's size)
    if (!actions) return { beads: [], ghost: null, analysis: [], knobRings: [], litKeys: [], playCards: [] };
    const viewRect = overlayViewRect();
    const nodes = app.nodes().filter((n) => !canSkipNode(n, viewRect));
    const pt = (x, y) => actions.worldToScreen(x, y);
    // THE BEADS ARE DRAWN BY THE PAINTER (core/node_chrome.portBeads), not here —
    // they are part of the node's picture and must appear in exports, in the
    // presenter and in the CLI render. What the OVERLAY adds is the interaction
    // affordance: a hit target that is always live, and, during a drag, the
    // highlight/dim that says where this wire may land.
    const beads = allPortBeads(nodes).map((b) => {
      const id = `${b.item}.${b.key}`;
      const verdict = wireDrag?.targets.get(id);
      return {
        id, ...pt(b.x, b.y), color: portColor(b.type), label: b.label, type: b.type,
        // Three states, and only while a wire is in flight: a legal target
        // (highlight), an illegal one (dim), or not a candidate at all. With no
        // drag running every bead is neutral — an always-on highlight would make
        // the canvas noisy for the entire time you are NOT wiring anything.
        target: wireDrag ? verdict === null : false,
        refused: wireDrag ? typeof verdict === "string" : false,
        hovered: wireDrag?.hovered?.item === b.item && wireDrag?.hovered?.key === b.key,
      };
    });
    // THE GHOST: anchor → cursor, or anchor → the bead being hovered (so it SNAPS
    // to a legal target before you release, which is what makes a drop feel
    // committed rather than approximate). Coloured by the anchor's type, and
    // switched to the refusal colour when the pointer is over an illegal bead —
    // the wire itself says no before the drop does.
    let ghost = null;
    if (wireDrag) {
      const a = pt(wireDrag.anchorXY.x, wireDrag.anchorXY.y);
      const end = wireDrag.hovered ? pt(wireDrag.hovered.x, wireDrag.hovered.y) : pt(wireDrag.cursor.x, wireDrag.cursor.y);
      const overRefused = !wireDrag.hovered && beadAt(wireDrag.beads, wireDrag.cursor.x, wireDrag.cursor.y, SNAP_PX / viewport.zoom);
      ghost = {
        // A BACKWARD drag (started at an unconnected input) is drawn cursor→anchor,
        // so the bezier's control points still leave an output rightward and enter
        // an input leftward. Without this the ghost would curl the wrong way for
        // exactly half of all wire gestures.
        d: wireDrag.anchor.isInput ? wireBezierPath(end, a) : wireBezierPath(a, end),
        color: overRefused ? null : portColor(wireDrag.anchor.type),
      };
    }
    // ── THE ANALYSIS NODES' SCREEN RECTS (NF-BIND) ───────────────────────────
    // Where AudioOverlay.svelte paints a live meter bar or spectrogram. This layer
    // carries only GEOMETRY — which node, and the screen box its readout occupies.
    // The live SAMPLES never come through here: they arrive on the engine's own rAF
    // into web/audioMirror.analysisData, and the overlay reads that Map on its own
    // frame. Routing audio data through this $derived would schedule a Svelte update
    // per meter per frame, which is exactly the per-frame reactivity the node
    // overlay is careful to avoid elsewhere.
    //
    // WHY IT IS AN OVERLAY AT ALL: an analysis node's bar is LIVE audio, which is
    // not document state. Drawing it in the plugin's emit() would make Δt = 0
    // produce two different pictures, breaking the determinism law, frame-range
    // sharding and export reproducibility together. The plugin paints the STATIC
    // form (card, frame, label); this paints the motion on top, in screen space,
    // exactly the way selection handles do — so no export and no cli/render.js ever
    // sees it.
    const analysis = nodes
      .filter((n) => n.plugin?.audioSpec?.overlay)
      .map((n) => {
        const s = n.state;
        const pad = AUDIO_OVERLAY_PAD;
        const tl = T.apply(n.world, pad, AUDIO_OVERLAY_TOP);
        const br = T.apply(n.world, (s.w ?? 0) - pad, (s.h ?? 0) - pad);
        const a = pt(tl.x, tl.y);
        const b = pt(br.x, br.y);
        return {
          id: n.itemId,
          kind: n.plugin.audioSpec.overlay,
          x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
        };
      })
      .filter((r) => r.w > 1 && r.h > 1);
    // ── THE KNOB FOCUS RING (wave 3) ─────────────────────────────────────────
    // The DIALS themselves are painted by the plugin (core/node_chrome.knobOps),
    // because a knob is part of the module's face and belongs in every export —
    // the founding message's "knobs on them". What is transient, and therefore
    // lives here beside the beads, is which dial the POINTER is on and which one
    // is being TURNED. That is editor state, not document state; putting it in
    // the display list would make a PNG export of a slide depend on where the
    // mouse happened to be, which is the same category error the analysis
    // overlay above exists to avoid.
    //
    // Empty except while knob focus is live, so a document with no audio nodes —
    // and an audio document nobody is editing — pays one null check.
    const knobRings = [];
    if (app.canvasMode?.handlerId === "knob_focus") {
      const focusNode = nodes.find((n) => n.itemId === app.canvasMode.itemId);
      const ui = knobFocusUi(focusNode?.itemId ?? null, app.canvasMode.itemId);
      for (const k of focusNode?.plugin?.knobLayout?.(focusNode.state) ?? []) {
        if (k.key !== ui.focusKey && k.key !== ui.activeKey) continue;
        const c = T.apply(focusNode.world, k.cx, k.cy);
        const edge = T.apply(focusNode.world, k.cx + KNOB_R + KNOB_FOCUS_GAP, k.cy);
        const cs = pt(c.x, c.y);
        const es = pt(edge.x, edge.y);
        knobRings.push({
          id: `${focusNode.itemId}.${k.key}`, ...cs,
          r: Math.hypot(es.x - cs.x, es.y - cs.y),
          // `active` = being turned right now, which reads brighter than a hover.
          active: k.key === ui.activeKey,
          bound: k.bound,
        });
      }
    }
    // ── THE PRESSED PIANO KEYS, AND THE PLAYABLE CARD'S TINT (WORKSTREAM CB) ──
    // User: "The keyboard doesn't press keys visually when I touch it" and "change
    // color a bit when selected".
    //
    // BOTH ARE OVERLAY, NOT DISPLAY LIST, and for the same reason the analysis
    // meters above are: a press is LIVE input and a selection is EDITOR state, so
    // painting either in a plugin's emit() would make a PNG export of a slide
    // depend on what the author was holding down or had clicked. The keyboard's
    // own paint() carries what is TRUE OF THE DOCUMENT — the keys, their QWERTY
    // labels and the playable badge — and this carries what is true of this
    // moment.
    //
    // `app.pressEpoch` is the dependency that makes it repaint: the press SET is a
    // plain Map in core/live_control.js (shared with the presenter, testable in
    // bare node), and a Map mutation is invisible to Svelte.
    app.pressEpoch; app.selection; // reactive deps: a press landed; the selection moved
    const litKeys = [];
    const playCards = [];
    {
      const playingId = app.canvasMode?.handlerId === "keyboard_play" ? app.canvasMode.itemId : null;
      for (const n of nodes) {
        if (!n.plugin?.playableKeys) continue;
        // THE TINT IS TWO STATES, NOT ONE. "Selected" is the user's word and the
        // milder step; PLAYING is the one that has taken the alphabet, and it
        // must not look like an ordinary selection — a mode that swallows every
        // letter has to be unmistakable, which is the same argument the mode's
        // HintBar takeover makes one surface up.
        // selectedIds() rather than `selection`, so ONE of a multi-selection
        // still tints — the heterogeneous multi-select is a shipped feature
        // (core/multiselect.js) and a widget that read only the primary would go
        // dark inside a band select that plainly includes it.
        const selected = app.selectedIds().includes(n.itemId);
        if (selected || playingId === n.itemId)
          playCards.push({ id: n.itemId, poly: cardPolygon(n), playing: playingId === n.itemId });
        for (const k of litKeyRects(n)) {
          // The key's four corners through the node's OWN world transform, so a
          // rotated or scaled keyboard's lit key sits exactly on the painted one.
          const pts = [[k.x, k.y], [k.x + k.w, k.y], [k.x + k.w, k.y + k.h], [k.x, k.y + k.h]]
            .map(([lx, ly]) => T.apply(n.world, lx, ly))
            .map((wp) => pt(wp.x, wp.y));
          litKeys.push({
            id: `${n.itemId}.${k.note}`,
            poly: pts.map((q) => `${q.x},${q.y}`).join(" "),
            black: k.black,
          });
        }
      }
    }
    return { beads, ghost, analysis, knobRings, litKeys, playCards };
  });

  /** Pure function. A node's CARD as a screen-space polygon — its four local
   *  corners through its own world transform, the same construction the lit keys
   *  use one scope up. */
  function cardPolygon(node) {
    const w = node.state.w ?? 0, h = node.state.h ?? 0;
    return [[0, 0], [w, 0], [w, h], [0, h]]
      .map(([lx, ly]) => T.apply(node.world, lx, ly))
      .map((wp) => actions.worldToScreen(wp.x, wp.y))
      .map((q) => `${q.x},${q.y}`).join(" ");
  }

  /** The inset from a node's card edge to its live-overlay rect, and the top inset
   *  that clears the title bar plus one port row. Local units, mapped through the
   *  node's own world transform so a rotated or scaled analysis node's overlay
   *  follows its card. */
  const AUDIO_OVERLAY_PAD = 10;
  const AUDIO_OVERLAY_TOP = 32;

  // ── DRIVING THE AUDIO MIRROR ───────────────────────────────────────────────
  // THE EDITOR'S FRAME, handed to the one audio seam — the same object this
  // component's paint() hands sceneIR, so what is heard is what is drawn.
  //
  // THIS COMPONENT IS NO LONGER THE ONLY DRIVER, and that was the defect (R7-2).
  // web/PresentMode.svelte calls mirrorAudioFrame with ITS frame, at ITS alpha,
  // every time it paints. Neither surface is special: the mirror takes an evaluated
  // [[slide, alpha]] frame exactly as cameraFrameIR does, and there is no mode
  // branch below it. Before this, the presenter never re-fired this effect (it
  // writes app.slideIndex only on exit and this component stays mounted underneath
  // it), so the engine sat frozen at the editor's slide for a whole presentation.
  //
  // IT READS app.state(), NOT app.nodes(). The mirror needs the item MAP — knobs and
  // connections — and nothing about geometry, so deriving a render tree for it would
  // be work thrown away. It also means moving a node's card, which changes the
  // derived tree on every pointermove, does not even reach this.
  //
  // app.state() AND NOT cameraFrame.evaluatedStateAt, deliberately and for one
  // reason: the editor's frame INCLUDES app.previewDelta, the live mid-gesture
  // edit that is not in app.doc yet. Turning an audio knob must be audible while
  // the pointer is still down, and app.state() is the evaluation the editor is
  // already painting from. The presenter has no preview to blend and reaches the
  // identical evaluation through evaluatedStateAt.
  //
  // AND IT IS CHEAP WHEN NOTHING AUDIO-SHAPED CHANGED, which is the point: reading
  // the scene is a walk over the item map and an unchanged scene diffs to ZERO
  // engine calls. A patch therefore keeps playing while it is edited, instead of
  // being torn down and rebuilt (a 40 ms guarded ramp per topology change) on every
  // frame of every drag.
  //
  // VIEWPORT AND SELECTION ARE DELIBERATELY NOT DEPENDENCIES. Panning the canvas or
  // clicking a node must not touch the audio graph.
  $effect(() => {
    app.doc; app.previewDelta; app.slideIndex; // reactive deps: the document, live edits, the slide
    mirrorAudioFrame(app.state(), app.registry);
  });

  // ── THE TYPED-NOTE SINK (WORKSTREAM CB) ──────────────────────────────────
  // web/keyboardPlay.js may NOT import web/audioMirror.svelte.js: the handler
  // registry imports keyboardPlay, the bare-node suites import the registry, and
  // a `.svelte.js` module declares `$state`, which does not exist outside Vite.
  // (Measured: the first version did import it and turned 57 node suites red.)
  // This component is not node-imported, so it is the right place to close that
  // last link — one assignment, at mount, of the function keyboardPlay calls.
  setNoteSink(playLiveNote);

  // ── A SLIDE CHANGE RELEASES EVERY HELD NOTE ───────────────────────────────
  // Without this, leaving a slide mid-chord leaves it sounding FOREVER: the keys
  // are released by a pointerup the new slide's canvas never sees, so the
  // note-offs are never sent, and a poly voice with no release scheduled holds
  // its envelope open. The result is a drone with no visible source — the
  // un-debuggable case, and the same one the mirror's `active: false` handling
  // exists to prevent for modules.
  //
  // Depends on the SLIDE ALONE, deliberately. Hanging it off `app.doc` as well
  // would cut a held note every time any property changed anywhere, which
  // includes the mirror's own knob writes.
  $effect(() => {
    app.slideIndex;
    releaseAllLiveNotes();
    // THE LIGHTS GO OUT WITH THE SOUND. releaseAllLiveNotes silences the ENGINE;
    // without this the overlay would keep a key lit that is making no sound —
    // the same un-debuggable shape as the drone above, with the two halves
    // swapped (core/live_control.releaseAllPresses states the pairing).
    //
    // ONLY IF SOMETHING WAS ACTUALLY LIT. This `if` is not an optimisation, it is
    // the fix for a SHIPPED BOOT CRASH (2026-08-03): bumping unconditionally made
    // this effect write on its very FIRST run, at mount, with no user gesture
    // anywhere — and because the counter's `++` read the state it wrote, the
    // effect became its own dependency and Svelte tripped
    // `effect_update_depth_exceeded` while drawing the first frame. The counter is
    // now `untrack`ed (web/app.svelte.js), so this can no longer loop; the guard
    // stays because an effect that signals "the picture changed" when nothing
    // changed is a false statement, and the next such counter should not have to
    // rediscover why.
    if (releaseAllPresses()) app.bumpPressEpoch();
  });

  // ── LEAVING KEYBOARD PLAY RELEASES ITS CHORD AND ITS LISTENER (CB) ────────
  // A mode can be left by Escape, by a slide change, by the item being purged and
  // by entering the presenter — four paths through app.exitCanvasMode(), which is
  // in the store and cannot reach a handler descriptor (web/knobFocus.js records
  // exactly this, and answers it by clearing on ENTRY). Play mode cannot use that
  // answer: it holds two things that outlive a clear — note-ons the engine is
  // still sounding, and a window keyup listener. Both must be undone AT THE EXIT,
  // whichever path it was, so this watches the one fact every path produces:
  // `app.canvasMode` ceasing to be this mode.
  let playingItemId = null;
  $effect(() => {
    const live = app.canvasMode?.handlerId === "keyboard_play" ? app.canvasMode.itemId : null;
    if (live === playingItemId) return;
    if (playingItemId) {
      releaseHeldKeys(app, playingItemId);
      resetKeyboardPlay();
      removeKeyUp();
    }
    playingItemId = live;
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
      <!-- THE LIVE ANALYSIS LAYER (NF-BIND): a small 2D canvas over each meter and
           spectrum node, drawing the bouncing bar and the flowing spectrogram. It
           sits here — over the Skia scene, under the SVG chrome, pointer-events:none
           — for the same reason the video overlays do, and because the node's STATIC
           picture is painted underneath it by the plugin. Live audio is not document
           state, so it can never be in emit(); see the component's docblock. -->
      <AudioOverlay rects={nodeOverlay.analysis} />
      <!-- THE AUTOPLAY SURFACE: absent when the deck has no audio, absent again once
           sound is running, and clickable in between. A patch that is silent because
           the browser has not been clicked must SAY so. -->
      <AudioBadge />
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
        class="overlay {modeCursorClass} {knobCursorClass}"
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
        <!-- ── THE PERSISTENT WIRES ARE NOT DRAWN HERE ANY MORE ────────────────
             They moved INTO THE SCENE (WORKSTREAM BN; render_gpu/ports.sceneIR
             splices core/node_chrome.wireLayerOps under the nodes), because the
             user asked for them everywhere: "the wires between nodes should be
             shown in prsentation mode and pdf rener and png render etc too
             please" (2026-08-03). An overlay path exists only in THIS component,
             so presentation mode and every exporter drew naked nodes joined by
             nothing.
             THIS BLOCK IS DELIBERATELY GONE RATHER THAN KEPT AS A SECOND COPY.
             Two drawings of one wire would be a double-draw the moment either
             side's width, colour or curve changed — the halo alone would darken
             every wire in the editor and nowhere else — and the editor would stop
             being an honest preview of what an export produces, which is the whole
             point of the display list. WIRES ARE NOT WIDGETS still holds: the
             scene emission creates no item, exactly as this block created none.
             What stays below is the INTERACTIVE half only — the ghost being
             dragged, and the bead highlights that say where it may land. Neither
             is document state, so neither belongs in an export. -->
        <!-- THE GHOST WIRE: the one being dragged right now. Dashed so it reads as
             provisional, and it turns to the refusal colour the moment the pointer
             is over a bead it cannot land on — the wire says no before the drop
             does. `color: null` IS that refusal state (set in nodeOverlay). -->
        {#if nodeOverlay.ghost}
          <path class="nf-wire-ghost" class:nf-refused={!nodeOverlay.ghost.color} d={nodeOverlay.ghost.d}
                style={nodeOverlay.ghost.color ? `--nf-wire-color: ${nodeOverlay.ghost.color};` : null} />
        {/if}
        <!-- THE PORT BEAD HIT LAYER. The bead's PICTURE is painted by the widget
             itself (core/node_chrome.portBeads) so it exists in exports, in the
             presenter and in the CLI render; these circles are the INTERACTION half
             — an always-live grab target, plus the highlight/dim that says where a
             wire in flight may land. Transparent when idle (see app.css): an
             always-on ring would double every bead the painter already drew.
             `pointer-events: none` on all of them, deliberately — the press is
             handled by the overlay's own onPointerDown through core/wire_drag.beadAt,
             which hit-tests in WORLD space against the same anchors the painter used,
             so the grab region cannot drift from the picture the way a parallel set
             of DOM targets would. -->
        {#each nodeOverlay.beads as bead (bead.id)}
          <circle
            class="nf-bead"
            class:nf-target={bead.target}
            class:nf-refused={bead.refused}
            class:nf-hovered={bead.hovered}
            cx={bead.x} cy={bead.y}
            style={`--nf-wire-color: ${bead.color};`}
          ><title>{bead.label} ({bead.type})</title></circle>
        {/each}
        <!-- THE KNOB FOCUS RING. Only ever non-empty inside knob focus, and only
             for the dial under the pointer or the one being turned — the dials
             themselves are painted by the widget, like the beads above and for
             the same reason (a knob belongs in an export; a hover does not).
             `bound` marks a knob holding an = equation, which the mode refuses to
             turn: the ring still appears, so the affordance is visible, and the
             skin says it will not move. -->
        {#each nodeOverlay.knobRings as ring (ring.id)}
          <circle class="nf-knob-ring" class:nf-knob-active={ring.active} class:nf-knob-bound={ring.bound}
                  cx={ring.x} cy={ring.y} r={ring.r} />
        {/each}
        <!-- THE PLAYABLE CARD'S TINT (WORKSTREAM CB — user: "change color a bit
             when selected"). A wash over the whole card, in the modulation
             family's own accent so it reads as that node getting brighter rather
             than as a new colour arriving. Two strengths: SELECTED is the mild
             one, PLAYING (the computer keyboard has the alphabet) is the loud one,
             because a mode that swallows every letter must be unmistakable.
             Drawn BEFORE the lit keys so a pressed key still reads on top of it. -->
        {#each nodeOverlay.playCards as card (card.id)}
          <polygon class="nf-play-card" class:nf-play-live={card.playing} points={card.poly} />
        {/each}
        <!-- THE PRESSED PIANO KEYS. Live input, so it can never be in the display
             list (an export must not depend on what was held down) — the analysis
             meters' seam, one widget over. Two skins because the keys are two
             colours: a wash that reads on a pale white key is invisible on a near
             black one. -->
        {#each nodeOverlay.litKeys as key (key.id)}
          <polygon class="nf-key-lit" class:nf-key-lit-black={key.black} points={key.poly} />
        {/each}
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
        {#if overlay.modalPivotSeg}
          <!-- R6-2.2: the red dashed cursor→pivot line, on BOTH the R and S
               modals — the visual proof of what the gesture measures against.
               `guide` is the red overlay stroke every other guide uses;
               `guide-dashed` is its dashed variant (guide colour + selection
               dash, the combination .band-rect and .crosshair-band already
               share). It replaces the bare pivot dot this block used to draw. -->
          <line class="guide guide-dashed" x1={overlay.modalPivotSeg.x1} y1={overlay.modalPivotSeg.y1} x2={overlay.modalPivotSeg.x2} y2={overlay.modalPivotSeg.y2} />
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
        <!-- INK-BOUNDS GHOST: the DASHED rect of where a widget's ink actually
             is, drawn only when that differs from its property box (for text:
             when the type overflows). Dashed rather than solid so it reads as a
             different KIND of boundary from the solid ghost outline above it —
             one is "this object has no volume", this one is "this object's
             contents leave its box". Clickable already, via the same rect in
             core/derive.clickableLocalRect. -->
        {#each overlay.inkGhostOutlines as o}
          <polygon class="ink-ghost-outline" points={o} />
        {/each}
        <!-- THE ITEM PICKER'S HOVER PREVIEW, drawn between the ghosts and the
             real selection so a hovered object reads as "this one" without ever
             being mistaken for the committed selection. Same polygon geometry
             (outlineOf), a different skin. -->
        {#each overlay.hoverOutlines as o}
          <polygon class="selection-preview" points={o} />
        {/each}
        {#each overlay.outlines as o}
          <polygon class="selection" points={o} />
        {/each}
        <!-- THE SELECTION INK DASH (WORKSTREAM NN, rendering per SS): a stroke
             widget's selection, dashed ALONG its ink rather than around a box that
             does not describe it. A near-vertical arrow's box is a ~zero-width
             sliver — the user's report was literally "selected arrows show
             nothing" — so these widgets get their morphPaths outline dashed
             instead.

             NO INLINE STROKE-WIDTH, and that is the SS ruling in one attribute's
             absence. NN set one per path, inflated from the widget's own stroke
             width; the result was the "fuzzy and thick" casing the user rejected.
             The width now comes from .selection-ink-dash in app.css, which takes
             --a-selection-stroke — the identical hairline the .selection polygon
             one block up uses — so an arrow and a rect read as one system, and the
             screen-space overlay keeps that weight at every zoom for free. -->
        {#each overlay.inkDashes as c}
          <path class="selection-ink-dash" d={c.d} />
        {/each}
        <!-- THE EQUATION LOCK'S SENTENCE FOR A BODY DRAG (todo #240). The third
             surface of one condition: a resize handle and a yellow square can each
             carry an SVG <title>, because the pointer reaches them; the selection
             outline is pointer-events:none like all overlay decoration, so a hover
             hint on it could never fire. The canvas's own way of saying something
             in place is the anchor tip — an SVG <text> with a halo over the art —
             and .lock-tip reuses that skin rather than minting a second one.
             It appears only with the lock ARMED (off by default) and only for an
             item that actually has a held coordinate, so it cannot be ambient
             noise; moveAffordance returns nothing in every other case. -->
        {#each overlay.lockTips as t}
          <text style={LOCK_TIP_STYLE} text-anchor={t.anchor} x={t.x} y={t.y + LOCK_TIP_Y}>
            {#each t.lines as line, i}
              <tspan x={t.x} dy={i === 0 ? -(t.lines.length - 1) * LOCK_TIP_LINE_H : LOCK_TIP_LINE_H}>{line}</tspan>
            {/each}
          </text>
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
               in app.css) so the box you are dragging can announce what a release
               will do, without moving the pointer or reading the HintBar.

               WHAT IS ACTUALLY DISTINGUISHED, corrected 2026-08-01 — this comment
               used to claim the box "announces whether a release adds, subtracts
               or inverts", which overstated it by two verbs. Only INVERT has an
               override (`.overlay .band-rect.band-verb-invert`, app.css:3389,
               amber). ADD and SUBTRACT deliberately keep the base `.band-rect`
               pink, which app.css:3386 states out loud — so they are also
               indistinguishable from the unmodified "replace" band. The two
               classes are applied and carry no rule ON PURPOSE; that is recorded
               as an exemption in tests/orphan_class_test.js rather than papered
               over with empty rules, which would imply a distinction that is not
               there. Whether add/subtract SHOULD get their own tone is a real
               open design question, not a bug — flagged, not silently "fixed". -->
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
        <!-- THE BAND'S INK-DASH PREVIEW (WORKSTREAM NN): the same two verbs, for
             the widgets whose box does not describe them. A band dragged over a
             vertical arrow has to preview the arrow, not an invisible sliver —
             and it must preview the SAME mark the release will commit to. Reuses
             the band verb skins on the ink-dash path, so add/remove read
             identically whichever indication a caught widget wears. -->
        {#each overlay.bandAddInkDashes as c}
          <path class="selection-ink-dash band-candidate band-add" d={c.d} />
        {/each}
        {#each overlay.bandRemoveInkDashes as c}
          <path class="selection-ink-dash band-candidate band-remove" d={c.d} />
        {/each}
        <ResizeHandles handles={overlay.handles} onstart={startResize} />
        {#each overlay.endpoints as ep}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- The lock skin is the SAME two elements a yellow square wears
               (lockedGlyphStyle + a <title>), because an endpoint refused by the
               equation lock and a modifier point refused by it are one condition
               and must not grow two appearances or two wordings. -->
          <circle
            class="endpoint"
            cx={ep.x} cy={ep.y} r="6"
            style={lockedGlyphStyle(ep)}
            onpointerdown={(e) => startEndpoint(ep.which, e)}
          >{#if ep.lockNote}<title>{ep.lockNote}</title>{/if}</circle>
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
               yellow squares"), drawn from THE HANDLE GLYPH BANK
               (core/handle_glyphs.js; protocol in core/registry.js "HANDLE
               IDENTITY"). A handle's `look` is {outline shape, inner mark, accent},
               already resolved in the overlay derivation — so the branching here is
               on the OUTLINE KIND (rect / circle / polygon), which is a fact about
               SVG, not on the bank's key list, which is a fact about the app. A new
               bank entry that reuses an existing outline kind needs NO change here.
               Every branch carries the identical class list, style, handlers and
               <title>, so a glyph choice cannot accidentally change a handle's
               BEHAVIOUR — only its picture. The accent is applied as a CSS custom
               property the .modifier rule reads, so the .selected / .hidden-element
               state overrides keep working untouched on top of any accent.
               THE HOVER TIP (handle identity) binds to these SAME elements: the
               grab region and the "what is this?" region are one region because
               they are one element. See hoverHandleId.
               RIGHT-CLICK a handle that backs a list element (hasElement) opens the
               point CONTEXT MENU (F.18). -->
          {@const g = glyphOutline(m.look, m.x, m.y)}
          {@const gstyle = lockedGlyphStyle(m)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g
            class="modifier-glyph"
            data-accent={m.look.accent}
            onpointerenter={() => { hoverHandleId = m.id; }}
            onpointerleave={() => { if (hoverHandleId === m.id) hoverHandleId = null; }}
            onpointerdown={(e) => startModifier(m.id, e)}
            oncontextmenu={(e) => openPointMenu(m, e)}
          >
            {#if m.lockNote}<title>{m.lockNote}</title>{/if}
            {#if g.kind === "rect"}
              <rect class="modifier" class:selected={m.selected} class:hidden-element={m.hidden} x={g.x} y={g.y} width={g.w} height={g.h} style={gstyle} />
            {:else if g.kind === "circle"}
              <circle class="modifier" class:selected={m.selected} class:hidden-element={m.hidden} cx={g.cx} cy={g.cy} r={g.r} style={gstyle} />
            {:else}
              <polygon class="modifier" class:selected={m.selected} class:hidden-element={m.hidden} points={g.points} style={gstyle} />
            {/if}
            <!-- THE INNER MARK, drawn in the RIM colour so it reads as engraving on
                 the glyph rather than a second object on top of it. pointer-events
                 are off on it (.modifier-mark) so the mark can never swallow a press
                 the outline was supposed to receive — the mark is decoration, the
                 outline is the target. -->
            {#if m.look.mark === "o"}
              <!-- The RADIUS comes from a token via the CSS `r` geometry property
                   (app.css .modifier-mark), not an SVG attribute, so the bank's
                   sizes live with the rest of the design tokens. -->
              <circle class="modifier-mark ring" cx={m.x} cy={m.y} />
            {:else if m.look.mark === "dot"}
              <circle class="modifier-mark dot" cx={m.x} cy={m.y} />
            {:else if m.look.mark === "x"}
              <path class="modifier-mark" d={`M ${m.x - HANDLE_R / 2} ${m.y - HANDLE_R / 2} L ${m.x + HANDLE_R / 2} ${m.y + HANDLE_R / 2} M ${m.x + HANDLE_R / 2} ${m.y - HANDLE_R / 2} L ${m.x - HANDLE_R / 2} ${m.y + HANDLE_R / 2}`} fill="none" />
            {/if}
          </g>
        {/each}
        <!-- THE HANDLE LABEL TIP. Drawn AFTER every glyph so it is never occluded by
             a neighbouring handle, and only for the ONE hovered handle that declares
             a `label` — an unlabelled handle (every handle that predates this) shows
             nothing at all. SUPPRESSED DURING A DRAG (`!app.dragging`): the pointer
             sits on the glyph for the whole gesture, so the tip would hang there
             stating something the user is already doing, and it would follow the
             handle around as visual noise over the very geometry being edited.
             Drawn inside the <svg> like the anchor tip, for the same reason: an HTML
             Tooltip cannot nest in SVG. -->
        {#if !app.dragging}
          {@const ht = overlay.modifiers.find((m) => m.id === hoverHandleId && m.label)}
          {#if ht}
            <text class="handle-label" x={ht.x} y={ht.y}>{ht.label}</text>
          {/if}
        {/if}
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
