<!--
  SyncPlayer [headless, general] — synchronized multi-video controller.

  Owns playback state (time, playing, loop, rate). Keeps registered
  <video> elements in sync via a master clock + drift correction.
  Renders nothing itself — passes state and actions to children.

  Each video can specify a clip range (start/end in seconds).
  Without syncDuration, master timeline = longest range, natural speed.
  With syncDuration, all ranges stretch/squish to fit that duration.

  Usage:
    <SyncPlayer>
      {#snippet children(state, actions)}
        <video use:actions.register src="a.mp4" muted />
        <video use:actions.register={{ start: 2, end: 8 }} src="b.mp4" muted />
        <ScrubBar {state} {actions} />
      {/snippet}
    </SyncPlayer>
-->
<script>
  /**
   * @typedef {Object} SyncState
   * @property {number} currentTime - Master timeline position in seconds
   * @property {number} duration - Master timeline duration in seconds
   * @property {boolean} playing
   * @property {boolean} looped
   * @property {number} playbackRate
   */

  /**
   * @typedef {Object} VideoConfig
   * @property {number} [start] - Clip start in seconds (default: 0)
   * @property {number} [end] - Clip end in seconds (default: video duration)
   */

  /**
   * @typedef {Object} VideoEntry
   * @property {HTMLVideoElement} node
   * @property {number} start
   * @property {number} end
   * @property {number} range - end - start
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

  /**
   * Pure function, general. Map master time to a video's local time.
   *
   * Without syncDuration (syncDur <= 0): 1:1 offset by clip start.
   * With syncDuration: scales master time so the clip range fills syncDuration.
   *
   * @example masterToLocal(2, { start: 5, range: 10 }, 0) // 7
   * @example masterToLocal(5, { start: 0, range: 3 }, 10) // 1.5
   */
  function masterToLocal(masterTime, entry, syncDur) {
    if (syncDur > 0 && entry.range > 0) {
      return entry.start + (masterTime / syncDur) * entry.range;
    }
    return entry.start + masterTime;
  }

  /**
   * Pure function, general. Compute the native playbackRate a video needs
   * so its clip range finishes in syncDuration at a given master rate.
   *
   * Without syncDuration (syncDur <= 0): just the master rate.
   * With syncDuration: scales by (clipRange / syncDuration).
   *
   * @example localRate(1, { range: 6 }, 3) // 2 (6s clip in 3s = 2x)
   * @example localRate(2, { range: 6 }, 3) // 4 (2x master * 2x stretch)
   * @example localRate(1, { range: 6 }, 0) // 1 (no sync, natural)
   */
  function localRate(masterRate, entry, syncDur) {
    if (syncDur > 0 && entry.range > 0) {
      return masterRate * (entry.range / syncDur);
    }
    return masterRate;
  }

  // -- Component --------------------------------------------------------------

  let {
    /** @type {number|undefined} Force all clips to this duration (stretch/squish) */
    syncDuration = undefined,
    children,
  } = $props();

  /** @type {VideoEntry[]} */
  let entries = [];

  let playing = $state(false);
  let looped = $state(false);
  let playbackRate = $state(1);
  let currentTime = $state(0);
  let duration = $state(0);

  /* Master clock bookkeeping (not reactive — internal) */
  let rafId = null;
  let clockStartMs = 0;
  let clockOffsetS = 0;

  function recomputeDuration() {
    if (syncDuration != null) {
      duration = syncDuration;
      return;
    }
    if (entries.length === 0) { duration = 0; return; }
    duration = Math.max(...entries.map(e => e.range));
  }

  /** Effective syncDur for masterToLocal (0 = natural mode) */
  function effectiveSyncDur() {
    return syncDuration != null ? syncDuration : 0;
  }

  /** Set each video's native playbackRate to match sync scaling.
      If the rate exceeds the browser's limit, caps at the last
      accepted value — drift correction covers the rest. */
  function applyRates() {
    const sd = effectiveSyncDur();
    for (const entry of entries) {
      try {
        entry.node.playbackRate = localRate(playbackRate, entry, sd);
      } catch {
        /* Browser rejected the rate — leave it at whatever it was last set to */
      }
    }
  }

  // -- Registration -----------------------------------------------------------

  /** Svelte action — use:actions.register on <video> elements. */
  function register(node, config = {}) {
    const entry = { node, start: 0, end: 0, range: 0, lastSeekMs: 0, seekLatencyMs: 16 };
    entries.push(entry);

    function onMeta() {
      entry.start = config.start ?? 0;
      entry.end = config.end ?? node.duration;
      entry.range = entry.end - entry.start;
      node.currentTime = entry.start;
      node.playbackRate = localRate(playbackRate, entry, effectiveSyncDur());
      recomputeDuration();
    }
    node.addEventListener("loadedmetadata", onMeta);
    if (node.readyState >= 1) onMeta();

    return {
      destroy() {
        entries = entries.filter(e => e !== entry);
        node.removeEventListener("loadedmetadata", onMeta);
        recomputeDuration();
      },
    };
  }

  // -- Master clock -----------------------------------------------------------

  const MAX_DRIFT_S = 0.05;

  function syncTick() {
    if (!playing || entries.length === 0) return;

    const elapsedS =
      ((performance.now() - clockStartMs) / 1000) * playbackRate;
    currentTime = clockOffsetS + elapsedS;

    if (currentTime >= duration) {
      if (looped) {
        loopRestart();
        return;
      } else {
        pauseAll();
        currentTime = duration;
        return;
      }
    }

    const sd = effectiveSyncDur();
    for (const entry of entries) {
      const target = masterToLocal(currentTime, entry, sd);
      const clamped = clamp(target, entry.start, entry.end);
      /* Scale drift threshold by effective rate — fast playback needs more slack
         to avoid fighting the decoder with corrective seeks every frame. */
      const effectiveRate = localRate(playbackRate, entry, sd);
      const driftThreshold = MAX_DRIFT_S * Math.max(1, effectiveRate);
      if (Math.abs(entry.node.currentTime - clamped) > driftThreshold) {
        entry.node.currentTime = clamped;
      }
    }

    rafId = requestAnimationFrame(syncTick);
  }

  /**
   * Query, general. Seek a video and resolve when the seek completes.
   *
   * @example await seekAndWait(videoEl, 2.5)
   */
  function seekAndWait(video, timeS) {
    return new Promise((resolve) => {
      function onSeeked() {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      }
      video.addEventListener("seeked", onSeeked);
      video.currentTime = timeS;
    });
  }

  /** Pause clock, seek all to 0, wait for all seeks to land, then resume. */
  async function loopRestart() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    for (const { node } of entries) node.pause();
    currentTime = 0;

    const sd = effectiveSyncDur();
    await Promise.all(entries.map((entry) => {
      const target = clamp(masterToLocal(0, entry, sd), entry.start, entry.end);
      return seekAndWait(entry.node, target);
    }));

    startClock(0);
    applyRates();
    for (const { node } of entries) {
      node.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("SyncPlayer: video play failed:", err);
        }
      });
    }
    rafId = requestAnimationFrame(syncTick);
  }

  function startClock(fromS) {
    clockStartMs = performance.now();
    clockOffsetS = fromS;
  }

  // -- Playback controls ------------------------------------------------------

  function playAll() {
    if (entries.length === 0) return;
    if (currentTime >= duration) seekAll(0);
    playing = true;
    startClock(currentTime);
    applyRates();
    for (const { node } of entries) {
      node.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("SyncPlayer: video play failed:", err);
        }
      });
    }
    rafId = requestAnimationFrame(syncTick);
  }

  function pauseAll() {
    playing = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const { node } of entries) node.pause();
  }

  function seekAll(timeS) {
    const t = clamp(timeS, 0, duration || 0);
    const sd = effectiveSyncDur();
    for (const entry of entries) {
      const target = masterToLocal(t, entry, sd);
      entry.node.currentTime = clamp(target, entry.start, entry.end);
    }
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

  const actions = {
    register,
    play: playAll,
    pause: pauseAll,
    toggle() {
      playing ? pauseAll() : playAll();
    },
    seek: seekAll,
    /** Scrub: update master time immediately, seek each video independently
        throttled by its own measured seek latency. Call on every input event. */
    scrubSeek(timeS) {
      const t = clamp(timeS, 0, duration || 0);
      currentTime = t;
      const now = performance.now();
      const sd = effectiveSyncDur();

      for (const entry of entries) {
        if (now - entry.lastSeekMs < entry.seekLatencyMs * 2) continue;
        entry.lastSeekMs = now;
        const target = clamp(masterToLocal(t, entry, sd), entry.start, entry.end);
        const seekStart = now;
        entry.node.currentTime = target;

        function onSeeked() {
          entry.node.removeEventListener("seeked", onSeeked);
          entry.seekLatencyMs = performance.now() - seekStart;
        }
        entry.node.addEventListener("seeked", onSeeked);
      }
    },
    seekToStart() {
      seekAll(0);
    },
    seekToEnd() {
      seekAll(duration);
    },
    toggleLoop() {
      looped = !looped;
    },
    setPlaybackRate(rate) {
      if (playing) startClock(currentTime);
      playbackRate = rate;
      applyRates();
    },
  };
</script>

{@render children(snapshot(), actions)}
