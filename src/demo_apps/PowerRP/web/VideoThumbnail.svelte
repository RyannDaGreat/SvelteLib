<!--
  VideoThumbnail — a REAL first-frame thumbnail for a video asset (manifest
  "ASSET UX ROUND 2": "the MOV doesnt have proper thumbnails" — video assets
  showed only a generic play-circle glyph). Fills its grid cell exactly like
  the SvelteLib Thumbnail component (same cover-fit square-tile contract), so
  it drops into the Asset Explorer grid and the AssetField picker modal
  side-by-side with image Thumbnails with zero layout changes.

  HOW (client-side, no server round-trip — manifest: "pick the simplest that
  fits"): a hidden `<video>` element loads the asset URL, seeks to a small
  epsilon (0 itself is unreliable on some codecs/containers — the poster
  frame is often black/undecoded at exactly t=0) and draws the decoded frame
  to a `<canvas>` once, then the video element is released. This reuses
  browser video decoding (already required for the video PLAYER widget), so it
  needs no server-side ffmpeg call and no new endpoint — the frames endpoint
  server/server.py already reserves stays scoped to the FILMSTRIP's N-frame
  strip, a distinct feature.

  LOUD FAILURE (no silent fallback): a video that fails to load or seek shows
  a visible error glyph + console.error — never a silently-blank tile and
  never a silent revert to the old generic play icon. The message itself is
  readable by hovering the glyph, through SvelteLib's immediate Tooltip
  (native title= is banned in app chrome — manifest). Cached per (src) in a
  module-level Map so re-rendering the same asset (grid re-list, reopening the
  picker) never re-decodes — decoding is the expensive part, not layout.

  Props: src (absolute, proxy-resolved video URL), onclick.
  Styling lives in app.css (.vidthumb*; app convention: NO <style> block here —
  this is a web/ app component, not a src/lib one. .vidthumb intentionally
  mirrors src/lib/Thumbnail.svelte's .thumb box model exactly (same
  width/height/cover-fit/definite-size contract its file header explains is
  required for the grid's row-sizing) so the two drop into the SAME grid
  interchangeably.
-->
<script module>
  /** Seek target (seconds) for the captured frame — not 0 (poster-frame
   * decode at the exact start is unreliable/black on some MOV/H.264 streams;
   * a small positive epsilon lands past the container's first keyframe on
   * every codec this app supports, per the manifest arbitrary-constants rule
   * this is linked to the "browsers must decode a keyframe to seek" constraint,
   * not an invented tuning number — 0.1s is comfortably inside a single GOP at
   * any realistic frame rate). */
  const THUMBNAIL_SEEK_SECONDS = 0.1;

  /** Module-level cache: src -> data URL of its captured frame (or a pending
   * Promise while capturing). Decoding a video frame is the expensive part;
   * caching it here means re-rendering the SAME asset (grid re-list, list
   * scroll, reopening the picker) never re-decodes. Not evicted (bounded by
   * the number of distinct video assets a project actually has — the same
   * unbounded-but-small-N tradeoff as the image registry's decode cache). */
  const FRAME_CACHE = new Map();

  /**
   * Command (drives an off-DOM <video> + <canvas>; the only impure step in
   * this module). Captures a still frame from a video URL as a PNG data URL,
   * memoized in FRAME_CACHE. Rejects loudly on load/seek/draw failure (no
   * silent blank-canvas fallback) — the caller shows the error state.
   *
   * @param {string} src Absolute video URL.
   * @returns {Promise<string>} data:image/png;base64,... of the captured frame.
   */
  function captureFrame(src) {
    if (FRAME_CACHE.has(src)) return FRAME_CACHE.get(src);
    const promise = new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.crossOrigin = "anonymous";
      const fail = (why) => reject(new Error(`VideoThumbnail: ${why} (${src})`));
      video.onerror = () => fail(`video failed to load — ${video.error?.message ?? "unknown error"}`);
      video.onloadedmetadata = () => {
        video.currentTime = Math.min(THUMBNAIL_SEEK_SECONDS, Math.max(0, video.duration / 2));
      };
      video.onseeked = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        } catch (e) {
          fail(`frame capture failed — ${e.message}`);
        }
      };
      video.src = src;
    });
    FRAME_CACHE.set(src, promise);
    promise.catch(() => FRAME_CACHE.delete(src)); // a failed capture can retry later (transient server hiccup)
    return promise;
  }
</script>

<script>
  import Tooltip from "../../../lib/Tooltip.svelte";

  let { src = "", onclick = () => {} } = $props();

  let frameUrl = $state(null);
  let failed = $state(null);

  $effect(() => {
    if (!src) return;
    frameUrl = null;
    failed = null;
    captureFrame(src).then(
      (url) => (frameUrl = url),
      (e) => {
        failed = e.message;
        console.error(e.message);
      },
    );
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="vidthumb" role="button" tabindex="0" {onclick} onkeydown={(e) => e.key === "Enter" && onclick(e)}>
  {#if frameUrl}
    <img class="vidthumb-img" src={frameUrl} alt="" loading="lazy" />
  {:else if failed}
    <Tooltip text={failed}>
      <div class="vidthumb-error"><iconify-icon icon="mdi:alert-circle-outline" width="20" height="20"></iconify-icon></div>
    </Tooltip>
  {:else}
    <div class="vidthumb-loading"><iconify-icon icon="mdi:play-circle-outline" width="28" height="28"></iconify-icon></div>
  {/if}
  <div class="vidthumb-badge"><iconify-icon icon="mdi:play" width="12" height="12"></iconify-icon></div>
</div>
