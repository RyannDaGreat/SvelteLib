/**
 * Video V6 — the <video> element registry (a COMMAND module: owns live DOM
 * media elements + their playback state). A fresh, clean equivalent of the
 * deleted gpu/video_registry.js — it does NOT reuse it.
 *
 * ONE <video> per distinct source string, shared across every V6 widget that
 * points at that src. The registry:
 *   - lazily CREATES an element for a src (autoplay/loop/muted from the widget),
 *   - GATES playback on the visible set (setActiveVideoV6): a clip NOT visible
 *     is paused → the browser stops decoding it (zero cost off-view); pause()
 *     preserves currentTime, so re-entering view RESUMES from the prior time
 *     rather than restarting,
 *   - drives per-PAINTED-frame repaints via requestVideoFrameCallback
 *     (onVideoV6Frame) — the precise signal that a new frame is ready, so the
 *     overlay redraws exactly once per decoded frame and never spins.
 *
 * Load failures are reported LOUDLY (console.error) and never swallowed.
 */

const HAVE_CURRENT_DATA = 2; // readyState at which importExternalTexture/texImage2D is valid

const registry = new Map(); // src -> { el, src, playing }
const frameSubscribers = new Set(); // callbacks invoked (src) => void per painted frame
let rvfcWarned = false; // one-time loud warning if requestVideoFrameCallback is missing

/**
 * Command. Get-or-create the shared <video> for `src`, configured from the
 * widget's playback flags. Muted defaults on because browsers block UNMUTED
 * autoplay. Attaches a LOUD error listener on first create. Idempotent: a second
 * call with the same src returns the same element (flags are set once, at
 * creation — the widget's flags are stable per src in practice).
 *
 * @param {string} src The video source (data: URI, URL, or asset URL).
 * @param {{autoplay:boolean, loop:boolean, muted:boolean}} flags Playback flags.
 * @returns {HTMLVideoElement} The shared element for this src.
 */
export function acquireVideoV6El(src, flags) {
  const existing = registry.get(src);
  if (existing) return existing.el;
  const el = document.createElement("video");
  el.crossOrigin = "anonymous";
  el.loop = flags.loop;
  el.muted = flags.muted; // MUST be true for autoplay to actually start (browser policy)
  el.playsInline = true;
  el.preload = "auto";
  el.src = src;
  el.addEventListener("error", () => console.error("Video V6: failed to load source", src, el.error));
  const entry = { el, src, playing: false };
  registry.set(src, entry);
  return el;
}

/**
 * Command. THE off-view gate. `activeSrcs` is the set of currently VISIBLE
 * (post-cull, on-slide) sources; `flagsBySrc` supplies each one's autoplay flag.
 *   - a VISIBLE + autoplay source that is paused → play() (resumes from its
 *     preserved currentTime) and starts its frame-callback loop,
 *   - a NON-visible source that is playing → pause() (browser stops decoding;
 *     currentTime is retained for resume),
 *   - a visible NON-autoplay source is left exactly as the user left it.
 * Only toggles on a real paused-state change, so calling it every rebuild never
 * thrashes playback. A rejected play() (autoplay policy) is reported, not hidden.
 *
 * @param {Set<string>} activeSrcs Visible source strings this frame.
 * @param {Map<string, {autoplay:boolean}>} flagsBySrc Per-src flags.
 */
export function setActiveVideoV6(activeSrcs, flagsBySrc) {
  for (const entry of registry.values()) {
    const visible = activeSrcs.has(entry.src);
    if (visible && (flagsBySrc.get(entry.src)?.autoplay ?? true) && entry.el.paused) {
      entry.playing = true;
      entry.el.play().catch((e) => console.error("Video V6: play() rejected for", entry.src, e));
      scheduleFrameCallback(entry);
    } else if (!visible && !entry.el.paused) {
      entry.el.pause(); // preserves currentTime → resume, not restart
      entry.playing = false;
    }
  }
}

/**
 * Command. Subscribe to per-painted-frame notifications (fired once per decoded
 * video frame while any clip plays). Returns an unsubscribe function — the
 * overlay uses it as its $effect cleanup.
 *
 * @param {(src:string) => void} cb Called with the source whose frame advanced.
 * @returns {() => void} Unsubscribe.
 */
export function onVideoV6Frame(cb) {
  frameSubscribers.add(cb);
  return () => frameSubscribers.delete(cb);
}

/**
 * Query. Is this source's element holding a drawable current frame? The overlay
 * engine also guards on this, but callers/tests can ask directly.
 *
 * @param {string} src
 * @returns {boolean}
 */
export function hasCurrentFrame(src) {
  const entry = registry.get(src);
  return !!entry && entry.el.readyState >= HAVE_CURRENT_DATA;
}

/**
 * Command. Pause + drop every tracked element (overlay teardown / remount).
 * A remount is a full reset, so losing currentTime here is acceptable.
 */
export function disposeVideoV6() {
  for (const entry of registry.values()) {
    entry.playing = false;
    entry.el.pause();
    entry.el.removeAttribute("src");
    entry.el.load();
  }
  registry.clear();
  frameSubscribers.clear();
}

/** Command. Notify all subscribers that `src` produced a new frame. */
function notifyFrame(src) {
  for (const cb of frameSubscribers) cb(src);
}

/**
 * Command. Start the per-frame callback loop for a playing entry. Uses
 * requestVideoFrameCallback (fires once per PAINTED frame — the precise signal);
 * if the browser lacks it, warns ONCE (loud, not silent) and polls via rAF while
 * playing. Self-cancels when the entry stops playing.
 *
 * @param {{el:HTMLVideoElement, src:string, playing:boolean}} entry
 */
function scheduleFrameCallback(entry) {
  const { el } = entry;
  if (typeof el.requestVideoFrameCallback === "function") {
    const cb = () => {
      if (!entry.playing) return;
      notifyFrame(entry.src);
      el.requestVideoFrameCallback(cb);
    };
    el.requestVideoFrameCallback(cb);
    return;
  }
  if (!rvfcWarned) {
    console.warn("Video V6: requestVideoFrameCallback unavailable — polling via requestAnimationFrame while playing");
    rvfcWarned = true;
  }
  const tick = () => {
    if (!entry.playing) return;
    notifyFrame(entry.src);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
