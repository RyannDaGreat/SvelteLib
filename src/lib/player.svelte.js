/**
 * player.svelte.js — headless video playback controller (Svelte 5 runes).
 *
 * Owns playback state (time, duration, playing, rate, loop) and a precise
 * scrub/seek engine with optional low-res proxy lockstep and label-restricted
 * ("play only good/bad regions") playback. It does NOT render anything and does
 * not own the <video> element's location — attach it with the `attachMain` /
 * `attachProxy` Svelte actions, so the video can live in a pan/zoom pane, a
 * simple stage, anywhere. The annotation model lives in the caller; the player
 * just reads it through the `getSegments` closure.
 *
 * Usage:
 *   const player = new Player(() => segments);
 *   <video use:player.attachMain src={src} muted></video>
 *   <video use:player.attachProxy src={proxySrc} muted></video>   // optional
 *   <button onclick={player.play}>play</button>
 *   {player.currentTime} / {player.duration}   // reactive
 */
import { clamp, labelAt, segmentToPlay } from "./segments.js";

const SEGMENT_EDGE_EPS = 1e-3; // don't re-seek when already at a region start

export class Player {
  currentTime = $state(0);
  duration = $state(0);
  playing = $state(false);
  looped = $state(false);
  playbackRate = $state(1);
  /** @type {'all'|'good'|'bad'} Which regions playback is restricted to. */
  playMode = $state("all");
  /** True while the main video is resolving a seek (no current frame yet). */
  mainSeeking = $state(false);
  /** Natural pixel size of the source video (0 until metadata loads). */
  videoW = $state(0);
  videoH = $state(0);

  #getSegments;
  #video = null;
  #proxy = null;
  #rafId = null;
  /** @type {{t:number,fast:boolean}|null} Latest target requested while the
      element was still resolving a prior seek — re-issued on its `seeked`
      (seek coalescing; see seekTo). One slot per element. */
  #mainPending = null;
  #proxyPending = null;

  /** @param {() => {start:number,end:number,label:string}[]} getSegments */
  constructor(getSegments = () => []) {
    this.#getSegments = getSegments;
  }

  /** Query (reactive). Label of the region under the playhead, or null. */
  get currentLabel() {
    return labelAt(this.#getSegments(), this.currentTime);
  }

  #allowedFor(mode) {
    return mode === "all" ? [] : this.#getSegments().filter((s) => s.label === mode);
  }

  // -- Svelte actions: bind the <video> elements --

  attachMain = (node) => {
    this.#video = node;
    const onMeta = () => {
      this.duration = node.duration;
      this.currentTime = node.currentTime;
      this.videoW = node.videoWidth;
      this.videoH = node.videoHeight;
    };
    const onSeeking = () => { this.mainSeeking = true; };
    const onSeeked = () => {
      this.mainSeeking = false;
      this.#flushPending("main");
    };
    node.addEventListener("loadedmetadata", onMeta);
    node.addEventListener("seeking", onSeeking);
    node.addEventListener("seeked", onSeeked);
    if (node.readyState >= 1) onMeta();
    return {
      destroy: () => {
        node.removeEventListener("loadedmetadata", onMeta);
        node.removeEventListener("seeking", onSeeking);
        node.removeEventListener("seeked", onSeeked);
        this.#stopLoop();
        this.#video = null;
      },
    };
  };

  attachProxy = (node) => {
    this.#proxy = node;
    const onSeeked = () => this.#flushPending("proxy");
    node.addEventListener("seeked", onSeeked);
    return {
      destroy: () => {
        node.removeEventListener("seeked", onSeeked);
        this.#proxy = null;
      },
    };
  };

  // -- seeking --

  /** Command. Seek main (and proxy) to t. `fast` uses fastSeek (nearest
      keyframe) for snappy scrubbing; programmatic jumps need exact landings.

      Coalesces under rapid scrubbing: while an element is still resolving a
      seek, only the most recent target is kept (#mainPending/#proxyPending) and
      re-issued once that seek lands (#flushPending). A burst of scrub events
      therefore can't queue up behind the decoder and stall it — each element
      chases the latest target at its own pace, and the final position always
      lands exactly. currentTime is updated synchronously regardless so the UI
      stays responsive. */
  seekTo = (t, fast = false) => {
    const clamped = clamp(t, 0, this.duration || 0);
    this.currentTime = clamped;
    this.#seekElement("main", this.#video, clamped, fast);
    this.#seekElement("proxy", this.#proxy, clamped, true);
  };

  /** Command. Issue a seek on one element, or stash it as that element's
      pending target if it is still mid-seek. `which` is "main" or "proxy". */
  #seekElement(which, el, t, fast) {
    if (!el) return;
    if (el.seeking) {
      if (which === "main") this.#mainPending = { t, fast };
      else this.#proxyPending = { t, fast };
      return;
    }
    if (fast && el.fastSeek) el.fastSeek(t);
    else el.currentTime = t;
  }

  /** Command. On an element's `seeked`, issue its stashed target if one arrived
      while it was busy. Only fires when a newer target was actually requested,
      so it converges (no re-seek loop) once scrubbing stops. */
  #flushPending(which) {
    const pending = which === "main" ? this.#mainPending : this.#proxyPending;
    if (!pending) return;
    if (which === "main") this.#mainPending = null;
    else this.#proxyPending = null;
    const el = which === "main" ? this.#video : this.#proxy;
    this.#seekElement(which, el, pending.t, pending.fast);
  }

  /** Command. Jump to a region boundary and keep playback alive (a big forward
      seek can briefly drop the element out of the playing state). */
  #jumpTo(t) {
    this.seekTo(t);
    if (this.playing && this.#video?.paused) {
      this.#video.play().catch((err) => {
        if (err.name !== "AbortError") console.error("Player: resume failed:", err);
      });
    }
  }

  // -- play loop --

  /** Command. rAF loop: mirror video time, enforce label-restricted playback.
      Region playback condenses the timeline — at one region's end it seeks
      straight to the next allowed region, skipping the gaps. */
  #tick = () => {
    const v = this.#video;
    if (!v) return;
    // While a seek is in flight, currentTime reports the *target*, not the real
    // decoded position — re-evaluating now would fire a fresh seek every frame
    // and the original seek would never land. Wait for it to settle.
    if (v.seeking) {
      this.#rafId = requestAnimationFrame(this.#tick);
      return;
    }
    this.currentTime = v.currentTime;

    if (this.playMode !== "all") {
      const allowed = this.#allowedFor(this.playMode);
      const target = segmentToPlay(allowed, this.currentTime);
      if (!target) {
        if (this.looped && allowed.length) this.#jumpTo(allowed[0].start);
        else return this.pause();
      } else if (this.currentTime < target.start - SEGMENT_EDGE_EPS) {
        this.#jumpTo(target.start);
      }
    } else if (this.currentTime >= this.duration) {
      if (this.looped) this.seekTo(0);
      else return this.pause();
    }

    this.#rafId = requestAnimationFrame(this.#tick);
  };

  #startLoop() {
    if (this.#rafId == null) this.#rafId = requestAnimationFrame(this.#tick);
  }
  #stopLoop() {
    if (this.#rafId != null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  // -- transport --

  play = () => {
    if (!this.#video || this.duration <= 0) return;
    this.playing = true;
    this.#video.playbackRate = this.playbackRate;
    this.#video.play().catch((err) => {
      if (err.name !== "AbortError") console.error("Player: play failed:", err);
    });
    this.#startLoop();
  };

  pause = () => {
    this.playing = false;
    this.#stopLoop();
    this.#video?.pause();
  };

  /** Command. Begin playback restricted to `mode` ('all'|'good'|'bad'),
      seeking into the first relevant region when the playhead is outside it. */
  startMode = (mode) => {
    this.playMode = mode;
    if (mode !== "all") {
      const allowed = this.#allowedFor(mode);
      if (allowed.length === 0) {
        this.pause();
        return;
      }
      const target = segmentToPlay(allowed, this.currentTime);
      if (!target) this.seekTo(allowed[0].start);
      else if (this.currentTime < target.start) this.seekTo(target.start);
    }
    this.play();
  };

  /** Command. Toggle a transport mode: pressing the active one pauses. */
  toggleMode = (mode) => {
    if (this.playing && this.playMode === mode) this.pause();
    else this.startMode(mode);
  };

  setRate = (rate) => {
    this.playbackRate = rate;
    if (this.#video) this.#video.playbackRate = rate;
  };

  toggleLoop = () => {
    this.looped = !this.looped;
  };

  // -- eased seek (e.g. clicking a comment jumps there smoothly) --

  #seekAnimId = null;

  /** Command. Ease the playhead to `target` seconds — exponential, so it
      decelerates into place (no acceleration). Used for comment jumps. While
      playing, just seeks instantly (no point animating against the play loop). */
  animateSeekTo = (target, tauMs = 45) => {
    const dest = clamp(target, 0, this.duration || 0);
    if (this.#seekAnimId != null) cancelAnimationFrame(this.#seekAnimId);
    if (this.playing || !this.#video) {
      this.seekTo(dest, true);
      return;
    }
    let last = performance.now();
    const step = (now) => {
      const dt = now - last;
      last = now;
      const k = 1 - Math.exp(-dt / tauMs);
      const next = this.currentTime + (dest - this.currentTime) * k;
      if (Math.abs(dest - next) < 0.01) {
        this.#seekAnimId = null;
        this.seekTo(dest, true);
      } else {
        this.seekTo(next, true);
        this.#seekAnimId = requestAnimationFrame(step);
      }
    };
    this.#seekAnimId = requestAnimationFrame(step);
  };
}
