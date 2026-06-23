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

  #getSegments;
  #video = null;
  #proxy = null;
  #rafId = null;

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
    };
    const onSeeking = () => { this.mainSeeking = true; };
    const onSeeked = () => { this.mainSeeking = false; };
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
    return { destroy: () => { this.#proxy = null; } };
  };

  // -- seeking --

  /** Command. Seek main (and proxy) to t. `fast` uses fastSeek (nearest
      keyframe) for snappy scrubbing; programmatic jumps need exact landings. */
  seekTo = (t, fast = false) => {
    const clamped = clamp(t, 0, this.duration || 0);
    this.currentTime = clamped;
    if (this.#video) {
      if (fast && this.#video.fastSeek) this.#video.fastSeek(clamped);
      else this.#video.currentTime = clamped;
    }
    if (this.#proxy) {
      if (this.#proxy.fastSeek) this.#proxy.fastSeek(clamped);
      else this.#proxy.currentTime = clamped;
    }
  };

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
