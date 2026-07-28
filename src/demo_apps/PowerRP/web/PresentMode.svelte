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
  import { fitRectView, canSkipNode } from "../core/view.js";
  import { SkiaSurface } from "../render_gpu/skia/browser_surface.js";
  import { isFadeFrame, renderTransitionFrame } from "./transitionRender.js";
  import { cameraFrameIR, evaluatedStateAt, evaluationAt } from "./cameraFrame.js";
  import { startParticleClock, stopParticleClock } from "../render_gpu/particle_clock.js";
  import { paintIsAnimated } from "../render_gpu/skia/materials.js"; // an animated MATERIAL fill/stroke/background must also keep the loop alive
  import { assetUrl } from "./projectApi.js";
  import { cameraDither } from "../render_gpu/skia/dither_shader.js";
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
    return deriveRenderTree(state, app.registry).some(
      (n) =>
        (n.state.animated === true ||
          // A plain shape with an ANIMATED MATERIAL paint has no widget-level
          // flag — the material registry is the only place that knows (the
          // "rainy window froze in the presenter" bug, manifest item 73).
          paintIsAnimated(n.state.fill) ||
          paintIsAnimated(n.state.stroke)) &&
        !canSkipNode(n, rect),
    );
  }

  /** Command. Starts/stops the at-rest animation rAF loop to match whether the
   *  current slide has a visible animated widget. Idempotent (safe to call on
   *  every frame): it flips the loop on/off only on a state change. */
  function syncIdleAnimation() {
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
    if (sound.startsWith("/")) return assetUrl(sound); // served path → resolve through the backend base
    if (/^[a-z][a-z0-9+.-]*:/i.test(sound)) return sound; // has a URI scheme (data:/http:/https:/blob:) → use verbatim
    return assetUrl(`/asset/${encodeURIComponent(app.projectName())}/${encodeURIComponent(sound)}`); // bare filename → project asset
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

  /** Command. Paints the current frame. Branches on whether this is a FADE
   * crossfade frame (async 2D snapshot blend) or an ordinary tween/instant
   * frame (direct GPU render). */
  function paint() {
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
    const ir = cameraFrameIR(state, app.doc.meta, app.registry, { cullRect: rect, view, viewW: w, viewH: h });
    gpu.render(ir, view, {
      background: [0, 0, 0, 1], // letterbox bars
      scissor: {
        x: (rect.x * view.zoom + view.panX) * dpr,
        y: (rect.y * view.zoom + view.panY) * dpr,
        w: rect.w * view.zoom * dpr,
        h: rect.h * view.zoom * dpr,
      },
      // The presenter honors the camera's render settings too (mirrors CanvasView):
      // dither de-bands and the AA mode drives coverage AA in the fullscreen show.
      dither: cameraDither(state),
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

  function exit() {
    presenter.stop();
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
    presenter.goTo(app.slideIndex);
    document.documentElement.requestFullscreen?.().catch(() => {}); // headless/iframe: fine without
    window.addEventListener("keydown", onkeydown, true);
    window.addEventListener("resize", paint);
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
      document.removeEventListener("fullscreenchange", onFsChange);
      presenter.stop();
      stopParticleClock(); // back to the PAUSED freeze regime (editor renders a still)
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
  <canvas bind:this={canvasEl} class:hidden={showFade}></canvas>
  <canvas bind:this={fadeEl} class:hidden={!showFade}></canvas>
  <div class="present-pos">{frame.index + 1} / {app.doc.slides.length}</div>
</div>
