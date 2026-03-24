<!--
  SyncPlayer — headless synchronized multi-video controller.

  Owns playback state (time, playing, loop, rate). Keeps registered
  <video> elements in sync via a master clock + drift correction.
  Renders nothing itself — passes state and actions to children.

  Usage:
    <SyncPlayer>
      {#snippet children(state, actions)}
        <video use:actions.register src="a.mp4" muted />
        <video use:actions.register src="b.mp4" muted />
        <ScrubBar {state} {actions} />
      {/snippet}
    </SyncPlayer>
-->
<script>
  /**
   * @typedef {Object} SyncState
   * @property {number} currentTime
   * @property {number} duration
   * @property {boolean} playing
   * @property {boolean} looped
   * @property {number} playbackRate
   */

  /**
   * @typedef {Object} SyncActions
   * @property {(node: HTMLVideoElement) => {destroy: () => void}} register - Svelte action for video elements
   * @property {() => void} play
   * @property {() => void} pause
   * @property {() => void} toggle
   * @property {(time: number) => void} seek
   * @property {() => void} seekToStart
   * @property {() => void} seekToEnd
   * @property {() => void} nextFrame
   * @property {() => void} prevFrame
   * @property {() => void} toggleLoop
   * @property {(rate: number) => void} setPlaybackRate
   */

  // -- Pure functions (general) -----------------------------------------------

  /**
   * Pure function, general. Clamp value to [min, max].
   *
   * @example clamp(5, 0, 10) // 5
   * @example clamp(-1, 0, 10) // 0
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // -- Component --------------------------------------------------------------

  const DEFAULT_FRAME_DURATION_S = 1 / 30;

  let {
    /** @type {number} Seconds per frame, for nextFrame/prevFrame */
    frameDuration = DEFAULT_FRAME_DURATION_S,
    children,
  } = $props();

  /** @type {HTMLVideoElement[]} */
  let videos = [];

  let playing = $state(false);
  let looped = $state(false);
  let playbackRate = $state(1);
  let currentTime = $state(0);
  let duration = $state(0);

  /* Master clock bookkeeping (not reactive — internal) */
  let rafId = null;
  let clockStartMs = 0;
  let clockOffsetS = 0;

  // -- Registration -----------------------------------------------------------

  /** Svelte action — use:actions.register on <video> elements. */
  function register(node) {
    videos.push(node);
    node.playbackRate = playbackRate;

    function onMeta() {
      const durations = videos.map(v => v.duration).filter(Number.isFinite);
      duration = durations.length ? Math.max(...durations) : 0;
    }
    node.addEventListener("loadedmetadata", onMeta);
    if (node.readyState >= 1) onMeta();

    return {
      destroy() {
        videos = videos.filter(v => v !== node);
        node.removeEventListener("loadedmetadata", onMeta);
        const durations = videos.map(v => v.duration).filter(Number.isFinite);
        duration = durations.length ? Math.max(...durations) : 0;
      },
    };
  }

  // -- Master clock -----------------------------------------------------------

  const DRIFT_THRESHOLD_S = 0.05;

  function syncTick() {
    if (!playing || videos.length === 0) return;

    const elapsedS =
      ((performance.now() - clockStartMs) / 1000) * playbackRate;
    currentTime = clockOffsetS + elapsedS;

    if (currentTime >= duration) {
      if (looped) {
        seekAll(0);
        startClock(0);
      } else {
        pauseAll();
        currentTime = duration;
        return;
      }
    }

    for (const v of videos) {
      if (Math.abs(v.currentTime - currentTime) > DRIFT_THRESHOLD_S) {
        v.currentTime = currentTime;
      }
    }

    rafId = requestAnimationFrame(syncTick);
  }

  function startClock(fromS) {
    clockStartMs = performance.now();
    clockOffsetS = fromS;
  }

  // -- Playback controls ------------------------------------------------------

  function playAll() {
    if (videos.length === 0) return;
    playing = true;
    startClock(currentTime);
    for (const v of videos) {
      v.play().catch((err) =>
        console.error("SyncPlayer: video play failed:", err),
      );
    }
    rafId = requestAnimationFrame(syncTick);
  }

  function pauseAll() {
    playing = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const v of videos) v.pause();
  }

  function seekAll(timeS) {
    const t = clamp(timeS, 0, duration || 0);
    for (const v of videos) v.currentTime = t;
    currentTime = t;
    if (playing) startClock(t);
  }

  // -- Cleanup ----------------------------------------------------------------

  $effect(() => {
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  });

  // -- Public API -------------------------------------------------------------

  function snapshot() {
    return { currentTime, duration, playing, looped, playbackRate };
  }

  /** @type {SyncActions} */
  const actions = {
    register,
    play: playAll,
    pause: pauseAll,
    toggle() {
      playing ? pauseAll() : playAll();
    },
    seek: seekAll,
    seekToStart() {
      seekAll(0);
    },
    seekToEnd() {
      seekAll(duration);
    },
    nextFrame() {
      pauseAll();
      seekAll(currentTime + frameDuration);
    },
    prevFrame() {
      pauseAll();
      seekAll(currentTime - frameDuration);
    },
    toggleLoop() {
      looped = !looped;
    },
    setPlaybackRate(rate) {
      /* Restart clock so elapsed calculation stays correct */
      if (playing) startClock(currentTime);
      playbackRate = rate;
      for (const v of videos) v.playbackRate = rate;
    },
  };
</script>

{@render children(snapshot(), actions)}
