<!--
  AudioOverlay — DEAD. THIS FILE IS A TOMBSTONE AND MUST BE DELETED.

  ── WHY IT IS STILL HERE ────────────────────────────────────────────────────
  R7-5 replaced it: an analysis node's live picture is now drawn by the node's own
  emit() into the display list (core/analysis_display.js), from a RING BUFFER OF
  MAGNITUDE COLUMNS held in render_gpu/gpu/live_analysis_registry.js. Nothing in
  this component is reachable any more — the `analysisData` Map it read no longer
  exists in web/audioMirror.svelte.js.

  It is not deleted yet only because web/CanvasView.svelte still imports and mounts
  it, and that file belongs to another writer this round. Deleting a module while a
  live import names it is a hard resolve failure that would red the whole worktree,
  so this renders nothing instead. **The moment CanvasView drops these four
  references, delete this file:**
    1. `import AudioOverlay from "./AudioOverlay.svelte";`
    2. `<AudioOverlay rects={nodeOverlay.analysis} />`
    3. the `analysis` array built in `nodeOverlay` (the block that transforms two
       corners with `T.apply` and reduces them to an axis-aligned box — that
       reduction IS the "doesn't rotate" symptom), plus `AUDIO_OVERLAY_PAD` /
       `AUDIO_OVERLAY_TOP`, whose values are `NODE_PAD` and
       `NODE_HEADER_H + NODE_BODY_GAP` written out as literals
    4. `analysis: []` in `nodeOverlay`'s empty-state literal

  ── WHAT WAS WRONG WITH IT, RECORDED SO IT IS NOT REBUILT ───────────────────
  The user's four symptoms were one root cause: the waterfall's history lived in
  the PIXELS of this component's <canvas>. The scroll was `drawImage(ctx.canvas,
  -1, 0)` — the canvas WAS the history buffer — so a zoom, which resizes the
  element, reset its backing store and ERASED the picture. The other three
  (always on top, never rotates, absent from every export) are what a DOM overlay
  is, not incidental bugs. core/analysis_display.js's header states it in full.

  A rewrite that had moved this drawing into emit() while keeping a pixel history
  would have fixed three of the four and left the one reported first.
-->
<script>
  /** Accepted and ignored: the caller is mid-migration (see the header). This
   *  component draws nothing and holds no state. */
  let { rects = [] } = $props();
  void rects;
</script>
