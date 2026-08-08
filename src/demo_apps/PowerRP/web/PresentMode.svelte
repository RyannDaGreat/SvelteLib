<!--
  PresentMode — fullscreen playback. Arrow keys step slides (tweened via
  core/presentation.js, honoring each slide's TRANSITION: type/seconds/curve —
  manifest Round 12); Esc exits. Renders through THE renderer (WebGPU) like the
  editor and the CLI.

  Two draw surfaces:
    - the GPU swapchain canvas: TWEEN and instant frames (direct present, fast).
    - a 2D FADE canvas: FADE frames only — a crossfade of the two completed-state
      snapshots (renderTransitionFrame), a pure function of alpha so the CLI can
      render the same frame. Only one surface is visible per frame.
-->
<script>
  import { onMount } from "svelte";
  import { createPresenter } from "../core/presentation.js";
  import { cameraRect, deriveRenderTree } from "../core/derive.js";
  import * as T from "../core/transform.js";
  import { enableAudio, fireLiveTrigger, mirrorAudioFrame, playLiveNote, releaseAllLiveNotes } from "./audioMirror.svelte.js";
  import { fitRectView, canSkipNode } from "../core/view.js";
  import { analysisFlowing } from "../render_gpu/gpu/live_analysis_registry.js"; // a live display is animated and declares no flag
  import { SkiaSurface } from "../render_gpu/skia/browser_surface.js";
  import { isFadeFrame, renderTransitionFrame } from "./transitionRender.js";
  import { cameraFrameIR, evaluatedStateAt, evaluationAt } from "./cameraFrame.js";
  import { startParticleClock, stopParticleClock } from "../render_gpu/particle_clock.js";
  import { startPointerFeed, stopPointerFeed, samplePointer } from "../core/pointer_input.js"; // RECORDABLE state: the presenter is the LIVE pointer regime
  import { resetSimulation } from "../core/simulation_history.js"; // SIMULATED STATE: a presentation is a fresh trajectory (see the mount)
  import { paintIsAnimated } from "../render_gpu/skia/materials.js"; // an animated MATERIAL fill/stroke/background must also keep the loop alive
  // assetStoreFor, NOT the bare assetStore(): a transition sound can belong to an
  // OPEN DRAFT, whose bytes live in the LOCAL store regardless of storageMode()
  // (web/storageMode.js) — the bare seam sent the draft key to the server.
  import { assetStoreFor } from "./storageMode.js"; // resolves a sound ref for THIS page's storage
  import { assetRef } from "./assetRef.js"; // the one "/asset/<project>/<file>" spelling
  import { cameraAntialias, antialiasCoverage } from "../render_gpu/skia/render_settings.js";

  let { app } = $props();

  let canvasEl = $state(null); // GPU swapchain (tween/instant)
  let fadeEl = $state(null); // 2D crossfade surface (fade frames)
  let frame = $state({ index: 0, alpha: 1, transition: null });
  let gpu = null; // set once at mount; the rAF presenter drives paint(), not reactivity
  // Which surface is showing (drives visibility). A fade frame shows the 2D
  // canvas; everything else shows the GPU canvas.
  let showFade = $state(false);
  // Monotonic token so a slow async fade render can't paint over a newer frame.
  let paintToken = 0;

  // The single Audio element for transition sounds — owned here (the DOM side),
  // NOT in core/presentation.js (which stays DOM-free so the CLI renders without
  // ever touching audio: the SPARKLER RULE — sounds are playback-only, never
  // rendered). One reusable element: each new transition-with-sound reloads its
  // src and restarts, so overlapping transitions never stack audio.
  let transitionAudio = null; // set at mount (browser only)

  // ANIMATED WIDGET continuous render (manifest "Animated is a TOGGLEABLE
  // PROPERTY"): between transitions the presenter is IDLE — it only paints on a
  // tween's rAF. A looping video (state.animated === true) would therefore
  // FREEZE at rest. So when the current RESTING slide has any VISIBLE animated
  // widget, we run our OWN rAF chain to keep repainting (importing each fresh
  // video frame). Re-evaluated ONLY when the frame changes (slide/alpha, in
  // onFrame) — never a per-frame full scene scan (the manifest's cheapness
  // requirement). `restingAnimated` caches that decision; `idleRaf` is the loop.
  let restingAnimated = false; // visible animated widget, or an equation reading `time`?
  let idleRaf = null; // rAF handle for the at-rest animation loop (null = idle)
  // Does the CURRENT frame's evaluation read the ambient pointer? Re-decided per
  // delivered frame in syncIdleAnimation; the gate on trackPointer's work.
  let pointerBound = false;

  const presenter = createPresenter(
    () => app.doc,
    (f) => {
      frame = f;
      paint();
      // Re-decide continuous rendering on EVERY delivered frame (this is the
      // "on slide/tween/visibility change" seam — a new frame is exactly such a
      // change). Cheap: one derive+cull pass here, not per rAF tick.
      syncIdleAnimation();
    },
    (transition) => playTransitionSound(transition), // fired ONCE per transition start
    // Inject THE frame scheduler (core/presentation.js stays DOM-free/bare-node;
    // the browser supplies rAF). Passed as the raw globals — requestAnimationFrame
    // needs no `this` binding.
    requestAnimationFrame,
    cancelAnimationFrame,
  );

  /** Query. Does the slide at the CURRENT frame (evaluated, culled to the
   *  camera) hold at least one VISIBLE animated widget?
   *
   *  LENS VISIBILITY IS FREE (manifest: "counting visibility THROUGH a magnifier
   *  lens region"): canSkipNode(node, cameraRect) IS the lens-visibility
   *  boundary. A magnifier lens only ever samples the ON-CANVAS pixels, which
   *  cover exactly the camera rect (core/view.js worldViewRect docstring). So a
   *  node NOT culled by the camera rect is contributing to the canvas the lens
   *  reads; a node culled by it contributes nothing to the canvas OR to any lens
   *  sampling that canvas. Thus the SAME cull test the render loop uses (paintGpu
   *  line: filter !canSkipNode(n, rect)) is exactly "visible, including through a
   *  lens" — no separate lens-region math is needed or correct. */
  function currentSlideHasVisibleAnimated() {
    const evaluation = evaluationAt(app.doc, frame.index, frame.alpha, app.registry);
    const state = evaluation.state;
    // THE PRESENTATION CLOCK also drives the loop. `clock` is non-null exactly when
    // some equation on this slide read `time` (core/expressions.evaluateState), so a
    // clock widget bound to `= time` — or ANY property bound to it, e.g. the
    // telescopic rig's tween variable — repaints without its plugin having to declare
    // `animated`. Derived from the pass that ran, so it cannot fall out of sync with
    // the equations the way a hand-set flag would; a deck that never writes `= time`
    // gets null and the loop stays off.
    if (evaluation.clock !== null) return true;
    // The CAMERA BACKGROUND is hand-assembled outside the derived tree and always
    // fills the view, so an animated background material (rainy window on the
    // camera) is checked directly — visibility is unconditional.
    const cam = Object.values(state.items ?? {}).find((it) => it?.type === "camera" && it.active !== false);
    if (cam && paintIsAnimated(cam.background)) return true;
    const rect = cameraRect(state, app.doc.meta);
    const visibleNodes = deriveRenderTree(state, app.registry, app.projectName())
      .filter((n) => !canSkipNode(n, rect));
    // A LIVE ANALYSIS DISPLAY (R7-5) is animated and declares none of the flags below:
    // it is not `state.animated`, it reads no `time`, and it is not a material paint. So
    // without this clause `restingAnimated` stayed false, `idleTick` never started, and a
    // spectrogram was FROZEN in the presenter — the same defect the editor had, for a
    // different reason. `analysisFlowing` asks about FRESHNESS (columns actually landing),
    // so it goes false by itself after the last one — on mute, on delete, on a
    // backgrounded tab — and it takes the POST-CULL list because an off-screen
    // spectrogram must not hold the loop open.
    if (analysisFlowing(visibleNodes)) return true;
    return visibleNodes.some(
      (n) =>
        n.state.animated === true ||
        // A plain shape with an ANIMATED MATERIAL paint has no widget-level
        // flag — the material registry is the only place that knows (the
        // "rainy window froze in the presenter" bug, manifest item 73).
        paintIsAnimated(n.state.fill) ||
        paintIsAnimated(n.state.stroke),
    );
  }

  /** Command. Starts/stops the at-rest animation rAF loop to match whether the
   *  current slide has a visible animated widget. Idempotent (safe to call on
   *  every frame): it flips the loop on/off only on a state change. */
  function syncIdleAnimation() {
    // THE AMBIENT POINTER (RECORDABLE state — manifest R7-24). `pointer` is non-null
    // exactly when some equation on this frame read `mouse_x`/`mouse_y`/`mouse_left`
    // (core/expressions.evaluateState), derived from the pass that ran rather than
    // from a source scan — the same rule `clock` follows above. Cached here, on the
    // seam that already re-decides per delivered frame, so a pointermove on a deck
    // that ignores the pointer costs one boolean instead of a world-space
    // conversion. The evaluation is memoized, so this second call is free.
    pointerBound = evaluationAt(app.doc, frame.index, frame.alpha, app.registry).pointer !== null;
    restingAnimated = currentSlideHasVisibleAnimated();
    if (restingAnimated && idleRaf === null) idleRaf = requestAnimationFrame(idleTick);
    else if (!restingAnimated && idleRaf !== null) { cancelAnimationFrame(idleRaf); idleRaf = null; }
  }

  /** Command. One tick of the at-rest animation loop. Repaints ONLY when the
   *  frame is settled (alpha === 1): while a transition is tweening, the
   *  presenter's OWN rAF is already repainting every frame (and importing fresh
   *  video frames), so this loop must not double-paint — it idles through the
   *  tween and resumes once the frame settles. Reschedules itself while
   *  restingAnimated holds. */
  function idleTick() {
    if (!restingAnimated) { idleRaf = null; return; }
    if (frame.alpha === 1) paint(); // at rest: drive the repaint (video frame advances)
    idleRaf = requestAnimationFrame(idleTick);
  }

  /** Query. The playable URL for a transition's `sound` value. The Inspector
   *  sound row stores a BARE asset filename (the user types it — the asset
   *  picker is a later wave); it resolves to the project's served asset path
   *  `/asset/<project>/<file>`. A value that is ALREADY a URL — a served path
   *  ("/asset/…"), a scheme URL ("http:", "https:", "blob:"), or a data: URI —
   *  is passed through untouched (the same resolution shape app.#resolvedSrc
   *  uses for image/video src, extended to any scheme so a pasted URL/data URI
   *  works too). */
  function soundUrl(sound) {
    // Resolution goes through THE STORAGE SEAM (assetStore().resolveUrl), so a
    // transition sound plays from the backend in server mode and from a blob:
    // object URL in browser-local mode. Previously this always built a server
    // path, so a static-mode deck's transition sounds silently 404'd.
    if (sound.startsWith("/")) return assetStoreFor(app.projectName()).resolveUrl(sound); // served path → this page's storage
    if (/^[a-z][a-z0-9+.-]*:/i.test(sound)) return sound; // has a URI scheme (data:/http:/https:/blob:) → use verbatim
    return assetStoreFor(app.projectName()).resolveUrl(assetRef(app.projectName(), sound)); // bare filename → project asset
  }

  /** Command. Plays a transition's sound ONCE, at transition start. No sound
   *  (null/empty) is SILENCE — the normal case, never an error. A load or play
   *  failure is LOUD (console.error) — a named asset that can't be heard is a
   *  reportable problem, not a silent no-op. Playback is user-gesture-legal:
   *  present mode is entered by a user action (Present button / key) and every
   *  advance is a keypress, so the browser's autoplay policy is satisfied (no
   *  muted-autoplay workaround needed); documented rather than assumed. */
  function playTransitionSound(transition) {
    const sound = transition?.sound;
    if (!sound || !transitionAudio) return; // no sound = silence (normal)
    const url = soundUrl(sound);
    transitionAudio.pause();
    transitionAudio.currentTime = 0;
    transitionAudio.src = url;
    // play() rejects on autoplay-block OR (separately) an 'error' event fires on
    // a load failure — cover BOTH loudly. The error handler is (re)assigned per
    // call so it names the current asset.
    transitionAudio.onerror = () =>
      console.error(`PowerRP transition sound: failed to load "${sound}" (${url}) — is it uploaded to this project's assets?`);
    transitionAudio.play().catch((e) =>
      console.error(`PowerRP transition sound: playback of "${sound}" (${url}) was blocked/failed:`, e));
  }

  /** Command. Paints the current frame — and MIRRORS IT INTO THE AUDIO ENGINE,
   * because a frame is a frame whichever organ receives it. Branches on whether
   * this is a FADE crossfade frame (async 2D snapshot blend) or an ordinary
   * tween/instant frame (direct GPU render); the audio call sits ABOVE that branch
   * because the sound of a fade is the sound of the document at that alpha,
   * crossfade or not.
   *
   * ── WHY HERE AND NOT IN THE PRESENTER'S onFrame ─────────────────────────────
   * paint() is called by every route that shows a frame: a tween tick, a
   * navigation, the at-rest animation loop (a knob bound to `= time`), a resize,
   * and the first frame after the GPU surface comes up. onFrame misses the last
   * three. Hanging the sound off "what is on screen" rather than off "what the
   * presenter announced" is what makes the two impossible to desynchronise.
   *
   * COSTS NOTHING WHEN NOTHING CHANGED: an unchanged scene diffs to zero engine
   * calls (web/audioMirror.svelte.js), so a per-rAF call during a tween issues
   * setParam only for knobs whose tweened value actually moved — which is exactly
   * the whoosh the user could not hear. */
  function paint() {
    mirrorAudioFrame(evaluatedStateAt(app.doc, frame.index, frame.alpha, app.registry), app.registry);
    const token = ++paintToken;
    if (isFadeFrame(app.doc, frame.index, frame.alpha)) paintFade(token);
    else paintGpu();
  }

  /** Command. GPU swapchain render of the tween/instant frame — THE CAMERA's
   * bbox at this (slide, alpha), letterboxed by a black clear + scissor. */
  function paintGpu() {
    showFade = false;
    if (!canvasEl || !gpu) return;
    const dpr = app.dpr(); // retina browser setting (manifest)
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (w === 0 || h === 0) return; // collapsed viewport → a 0×0 GL surface is null (skip)
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
    // The presentation views THE CAMERA's bbox at this (slide, alpha) — the
    // camera tweens between slides. Evaluated state: any property may be an
    // equation. Letterbox = black clear + scissor to the camera region (the
    // camera background is the first draw, since loadOp clear paints the bars).
    // cameraFrameIR is THE shared camera-frame recipe (bg rect + culled scene);
    // culling to the camera rect matches the editor/thumbnail path exactly.
    const state = evaluatedStateAt(app.doc, frame.index, frame.alpha, app.registry);
    const rect = cameraRect(state, app.doc.meta);
    const view = fitRectView(rect, innerWidth, innerHeight, dpr);
    // Pass the live view + device size so cameraFrameIR re-rasters placed PDF
    // pages at the presentation's display resolution (crisp when the camera
    // zooms into a page), bounded to the on-screen region (manifest RENDER PIVOT).
    const ir = cameraFrameIR(state, app.doc.meta, app.registry, { cullRect: rect, view, viewW: w, viewH: h, project: app.projectName() });
    gpu.render(ir, view, {
      background: [0, 0, 0, 1], // letterbox bars
      scissor: {
        x: (rect.x * view.zoom + view.panX) * dpr,
        y: (rect.y * view.zoom + view.panY) * dpr,
        w: rect.w * view.zoom * dpr,
        h: rect.h * view.zoom * dpr,
      },
      // The presenter honors the camera's render settings too (mirrors CanvasView):
      // the AA mode drives coverage AA in the fullscreen show. Dither is not among
      // them — it is a PAINT property now and rides each gradient's own shader.
      antialias: antialiasCoverage(cameraAntialias(state)),
    });
    app.renderFrameCount += 1; // the FPS counter reads PRESENTATION frames (round 11)
  }

  /** Command (async). FADE crossfade of the two completed-state snapshots,
   * letterboxed onto the 2D surface. Bounded to the CAMERA region so the fade
   * matches the tween's letterbox (bars stay black). */
  async function paintFade(token) {
    if (!fadeEl) return;
    const dpr = app.dpr();
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    // The camera rect at the completed NEW slide defines the fit + letterbox
    // (both endpoints share the deck's camera; the new slide's is the target).
    const state = evaluatedStateAt(app.doc, frame.index, 1, app.registry);
    const rect = cameraRect(state, app.doc.meta);
    const view = fitRectView(rect, innerWidth, innerHeight, dpr);
    // Camera region in device px (the fit places the whole rect on screen).
    const camW = Math.max(1, Math.round(rect.w * view.zoom * dpr));
    const camH = Math.max(1, Math.round(rect.h * view.zoom * dpr));
    const camX = Math.round((rect.x * view.zoom + view.panX) * dpr);
    const camY = Math.round((rect.y * view.zoom + view.panY) * dpr);
    // renderTransitionFrame does the pure crossfade at the camera's own
    // resolution; we then place it inside the letterbox.
    const crossfade = await renderTransitionFrame(app.doc, frame.index, frame.alpha, app.registry, camW, camH);
    if (token !== paintToken) return; // a newer frame superseded this one
    if (fadeEl.width !== w || fadeEl.height !== h) {
      fadeEl.width = w;
      fadeEl.height = h;
    }
    const ctx = fadeEl.getContext("2d");
    ctx.fillStyle = "#000"; // letterbox bars, matching the GPU path
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(crossfade, camX, camY);
    showFade = true;
    app.renderFrameCount += 1;
  }

  // Present-mode key DISPATCH lives here: a CAPTURE-phase window listener (see
  // onMount) that stopPropagation()s so present mode owns these keys during the
  // fullscreen takeover — App.svelte's bubble-phase registry dispatch never
  // sees them. This IS the mechanism; App.svelte registers the SAME keys as
  // display-only shortcut entries (guarded on `presentMode`) purely so the
  // single-source-of-truth registry KNOWS them and the HintBar reflects them
  // ("a shortcut not in the registry does not exist"). Keep the two in sync:
  //   ArrowRight / Space / PageDown → next; ArrowLeft / PageUp → prev; Escape → exit.
  function onkeydown(e) {
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") presenter.next();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") presenter.prev();
    else if (e.key === "Escape") exit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ── PLAYING A PATCH FROM THE PRESENTER ───────────────────────────────────
  //
  // "I need nodes in the UI so that some of these patches I can play with them.
  // I need to be able to play with them myself." (user, 2026-08-03). That is not
  // an editor-only request: a Button or a Keyboard on a slide must be playable in
  // front of an audience, which is the whole reason those widgets exist.
  //
  // WHY THIS IS A SEPARATE, SMALLER PATH THAN THE CANVAS'S. The presenter paints
  // to a bare canvas and has no selection, no drag machinery and no hit-test
  // infrastructure — deliberately, because there is nothing to edit here. So it
  // does exactly one thing: map the click back into world space through the SAME
  // view the frame was painted with, ask the derived tree which node is under it,
  // and route a live event. No selection is set, nothing is written, and no undo
  // unit is created — none of those concepts exist in this mode.
  //
  // TRANSITIONS ARE NOT PLAYABLE (`frame.alpha !== 1`): mid-tween the widget is
  // between two positions, so a press would land on a node that is not where it
  // appears to be for either endpoint. Waiting for the frame to settle is a
  // fraction of a second and is what the picture already implies.

  /** Pure function. A CLIENT point (CSS px) in WORLD coordinates, inverting the
   *  same `fitRectView` mapping paintGpu used for this frame. */
  function worldPointOf(e) {
    const state = evaluatedStateAt(app.doc, frame.index, frame.alpha, app.registry);
    const view = fitRectView(cameraRect(state, app.doc.meta), innerWidth, innerHeight, app.dpr());
    return { x: (e.clientX - view.panX) / view.zoom, y: (e.clientY - view.panY) / view.zoom, state };
  }

  /** Query. The topmost derived node under a world point whose plugin declares a
   *  live-play surface, plus the point in that node's LOCAL frame. */
  function livePlayHit(w, state) {
    const nodes = deriveRenderTree(state, app.registry, app.projectName());
    // BACK TO FRONT: the derived tree is in paint order, so the LAST match is the
    // one actually visible — the same rule core/keyboard_layout.keyAt follows for
    // the black keys, and for the same reason.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const plugin = node.plugin;
      if (!plugin?.livePress && !plugin?.livePlay) continue;
      const local = T.apply(T.invert(node.world), w.x, w.y);
      if (plugin.livePress?.hit(node.state, local.x, local.y)) {
        return { node, kind: "press", port: plugin.livePress.port };
      }
      const note = plugin.livePlay?.noteAt(node.state, local.x, local.y);
      if (note) return { node, kind: "note", note };
    }
    return null;
  }

  // ── THE AMBIENT POINTER, LIVE (manifest R7-24, core/pointer_input.js) ──────
  //
  // The presenter is the LIVE regime for the pointer for exactly the reason it is
  // the live regime for the clock: every other consumer renders a STILL and must be
  // byte-reproducible, so they inherit the frozen default and this one opts in. The
  // feed is started at mount and stopped in the cleanup, beside startParticleClock.
  //
  // WHY THE SAMPLE IS IN WORLD UNITS: the seam stores world coordinates so that
  // `x = mouse_x` means the same thing on every display (core/pointer_input.js's
  // header). worldPointOf already inverts the exact fitRectView this frame was
  // painted with, which is the same mapping the live-play hit test uses — one
  // conversion, not two that could disagree.

  /** Command (writes the ambient pointer seam; may repaint). Records the pointer in
   *  WORLD units and repaints when it actually moved on a frame that reads it.
   *
   *  `e.buttons & 1` is the LEFT BUTTON HELD RIGHT NOW, which is what `mouse_left`
   *  is — a value at every instant, not the click EVENT `e.button` describes (see
   *  POINTER_KEYWORDS on why a moment cannot be a leaf). On pointerup the released
   *  button is already out of `buttons`, so the same expression reports the release.
   *
   *  Gated on `pointerBound` so a deck that ignores the pointer pays one boolean per
   *  mouse event; gated on `alpha === 1` for the repaint because a tween is already
   *  painting every frame and must not be double-painted (idleTick's rule).
   *
   *  Bound on the WINDOW, not on a canvas, and not in the markup: the two present
   *  surfaces swap visibility per frame (`.hidden` is display:none), so a
   *  canvas-bound listener would go deaf for the duration of every fade, and a
   *  wrapper div carrying pointer handlers needs an ARIA role it has no honest one
   *  for. The window is where this file already listens for keydown and resize, and
   *  present mode owns the whole viewport. The live-play handlers below keep their
   *  own canvas bindings, which is right: THEY need the canvas's pointer capture. */
  const POINTER_EVENTS = ["pointermove", "pointerdown", "pointerup", "pointercancel"];

  function trackPointer(e) {
    if (!pointerBound) return;
    const w = worldPointOf(e);
    const moved = samplePointer(w.x, w.y, (e.buttons & 1) !== 0);
    if (moved && frame.alpha === 1) paint();
  }

  /** Command. A press in the presenter: fire a trigger, or start a note. */
  function onPresentPointerDown(e) {
    if (e.button !== 0 || frame.alpha !== 1) return;
    const w = worldPointOf(e);
    const hit = livePlayHit(w, w.state);
    if (!hit) return;
    if (hit.kind === "press") {
      fireLiveTrigger(w.state.items ?? {}, app.registry, hit.node.itemId, hit.port);
      return;
    }
    playLiveNote(w.state.items ?? {}, app.registry, hit.node.itemId, "on", hit.note.note, hit.note.frequency);
    heldNote = { itemId: hit.node.itemId, note: hit.note.note };
    canvasEl.setPointerCapture(e.pointerId);
  }

  /** Command. Release the held note. Also runs on pointercancel, because a
   *  cancelled gesture that skipped this would hold its note forever. */
  function onPresentPointerUp() {
    if (!heldNote) return;
    const state = evaluatedStateAt(app.doc, frame.index, frame.alpha, app.registry);
    playLiveNote(state.items ?? {}, app.registry, heldNote.itemId, "off", heldNote.note, 0);
    heldNote = null;
  }

  /** The note currently held by the presenter's pointer, or null. Module scratch:
   *  a gesture in flight is not state, and there is at most one pointer. */
  let heldNote = null;

  function exit() {
    presenter.stop();
    // A HELD NOTE DOES NOT SURVIVE THE PRESENTER. Leaving fullscreen mid-press
    // means the pointerup lands on the editor, which never saw the pointerdown,
    // so without this the note sounds forever with nothing on screen to explain
    // it — the un-debuggable case.
    onPresentPointerUp();
    releaseAllLiveNotes();
    // Land the editor on the slide that was being PRESENTED (user ruling
    // 2026-07-28), not the slide it happened to be on before Present started —
    // "exit me to the slide which I was last viewing".
    app.slideIndex = presenter.index;
    if (document.fullscreenElement) document.exitFullscreen();
    app.mode = "edit";
  }

  onMount(() => {
    // The one reusable transition-sound element (see playTransitionSound). Not
    // added to the DOM — an out-of-tree Audio() plays fine and needs no layout.
    transitionAudio = new Audio();
    // PARTICLE ANIMATION CLOCK (manifest 13.5): present mode is the LIVE regime —
    // start the ambient wall clock so any visible particle emitter animates. The
    // presenter's existing rAF loops (tween ticks + the restingAnimated idle loop
    // that already runs for `animated` widgets) repaint every frame and read the
    // advancing time. Every other consumer (editor/CLI/thumbnails/export) leaves
    // the clock PAUSED → a deterministic freeze still. Stopped on exit (cleanup).
    startParticleClock();
    // THE AMBIENT POINTER (manifest R7-24): present mode is the LIVE regime for the
    // pointer too, and for the identical reason — every other consumer renders a
    // still and inherits the frozen default, so a thumbnail, a CLI still and an
    // export cannot depend on where the mouse happens to be. Starts FROM REST, so a
    // presentation begins at the authored initial condition exactly as the clock and
    // the simulation do. Stopped in the cleanup below.
    startPointerFeed();
    // SIMULATED STATE (manifest R7-9): a presentation starts from the AUTHORED
    // INITIAL CONDITION, always. startParticleClock re-bases the clock to 0, so
    // the automatic backwards-time reset covers this entry today — but only by
    // arithmetic, and a presenter that ever resumed from a nonzero t0 would
    // silently continue the previous run's trajectory. Stated explicitly here
    // because "when does history reset" is a documented rule, not an emergent one.
    resetSimulation();
    // ENTERING PRESENT IS A GESTURE, SO SPEND IT (R7-3). The user reached here by
    // clicking Present or pressing its shortcut, which is a user activation the
    // browser will accept — so a deck whose first slide is a patch is audible from
    // the first frame instead of from the presenter's first click. The mirror's own
    // one-shot harvest covers every other entry; this one is here because a
    // presentation is the case where waiting for a stray click in front of an
    // audience is worst.
    enableAudio();
    presenter.goTo(app.slideIndex);
    document.documentElement.requestFullscreen?.().catch(() => {}); // headless/iframe: fine without
    window.addEventListener("keydown", onkeydown, true);
    window.addEventListener("resize", paint);
    // THE AMBIENT POINTER's live feed (see trackPointer). All four types, because
    // `mouse_left` is the button HELD: a press and a release change it with no
    // movement, and a cancelled gesture must not leave it stuck down.
    for (const type of POINTER_EVENTS) window.addEventListener(type, trackPointer);
    const onFsChange = () => {
      if (!document.fullscreenElement) exit();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    // THE renderer (Skia/WebGL2), async init: frames before the surface is ready
    // are skipped (black); failure is LOUD and exits present mode.
    SkiaSurface.create(canvasEl, { antialias: antialiasCoverage(cameraAntialias(app.state())) })
      .then((g) => {
        gpu = g;
        paint();
        // The initial goTo fired onFrame BEFORE the surface existed (paint was a
        // no-op then); re-sync now so a first slide that holds an animated
        // widget starts its continuous render as soon as the renderer is up.
        syncIdleAnimation();
      })
      .catch((e) => {
        console.error("PowerRP: Skia/WebGL init failed in present mode:", e);
        exit();
        throw e;
      });
    return () => {
      window.removeEventListener("keydown", onkeydown, true);
      window.removeEventListener("resize", paint);
      for (const type of POINTER_EVENTS) window.removeEventListener(type, trackPointer);
      document.removeEventListener("fullscreenchange", onFsChange);
      presenter.stop();
      stopParticleClock(); // back to the PAUSED freeze regime (editor renders a still)
      stopPointerFeed(); // …and the pointer with it: the editor must render POINTER_REST, not the last presented position
      // AND THE SIMULATION WITH IT — the editor must show the initial condition
      // again, not wherever the presentation left the pendulum. THE EXIT IS NOT
      // COVERED BY THE BACKWARDS-TIME RESET: leaving a presentation SHORTER than
      // EDITOR_FREEZE_TIME is a jump FORWARD into the freeze (2 s), so the next
      // editor evaluation would take one spurious clamped step instead of
      // resetting. Measured on the twin defect in core/simulation_history's
      // observeClock, which is where that discontinuity was first found.
      resetSimulation();
      if (idleRaf !== null) { cancelAnimationFrame(idleRaf); idleRaf = null; } // stop the at-rest anim loop
      restingAnimated = false;
      if (transitionAudio) { transitionAudio.pause(); transitionAudio.src = ""; transitionAudio = null; } // release audio
      // Free the Skia/WebGL surface on present→exit: a SkiaSurface owns a WebGL2
      // context + GrContext + GL surface that otherwise leak on every present.
      gpu?.dispose();
      gpu = null;
    };
  });
</script>

<div class="present">
  <canvas
    bind:this={canvasEl}
    class:hidden={showFade}
    onpointerdown={onPresentPointerDown}
    onpointerup={onPresentPointerUp}
    onpointercancel={onPresentPointerUp}
  ></canvas>
  <canvas bind:this={fadeEl} class:hidden={!showFade}></canvas>
  <div class="present-pos">{frame.index + 1} / {app.doc.slides.length}</div>
</div>
