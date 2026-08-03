<!--
  AudioBadge [NF-BIND] — the autoplay surface.

  ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
  Browsers refuse to start an AudioContext without a user gesture. So a slide with a
  fully-wired, perfectly correct patch on it is SILENT when you open it, and that
  silence is indistinguishable from a broken patch, a muted speaker, or a bug. The
  synth engine's own docblock makes the point for dev.html: "a synth that is silently
  suspended looks exactly like a synth that is broken."

  This is the editor's answer, and the brief's requirement: surfaced HONESTLY, "a
  small unobtrusive 'audio off — click to enable' state, not silence with no
  explanation."

  ── THE RESTRAINT RULES IT FOLLOWS ──────────────────────────────────────────
  IT IS ABSENT WHEN THERE IS NO AUDIO. A deck with no audio widgets shows nothing at
    all — the overwhelming majority of decks, which must not grow a permanent chip
    about a feature they do not use.
  IT DISAPPEARS ONCE SOUND IS ON. A running patch needs no badge; the sound IS the
    indicator, and the meters are already bouncing. Leaving a green "audio on" chip
    up forever would be decoration.
  IT IS A REAL BUTTON when it can act, because it must be reachable from the
    keyboard and because the browser requires a genuine user gesture — not a
    synthetic one, not a programmatic resume.
  IT CARRIES ITS REASON when it fails. "Audio failed" with no sentence is the same
    unhelpful silence the badge exists to replace, so `audioState.reason` is shown.

  Styling is in app.css per the app convention (no <style> blocks in app components).
-->
<script>
  // THE APP-WIDE TOOLTIP, not a native `title=`. That ban is real and
  // tests/native_tooltip_ban_test.js enforces it — a native tooltip waits about a
  // second before appearing and is unthemed, so the sentence explaining WHY a patch
  // is silent would arrive after the user had already concluded it was broken. That
  // sentence is the whole reason this control exists, so it must appear immediately.
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { audioState, enableAudio } from "./audioMirror.svelte.js";

  /** The four surfaced states. `idle` renders nothing (see the markup guard):
   *  there is no audio on this slide, so there is nothing to report. */
  const LABELS = {
    blocked: "audio off — click to enable",
    starting: "starting audio…",
    failed: "audio unavailable",
  };
</script>

{#if audioState.status === "blocked" || audioState.status === "starting" || audioState.status === "failed"}
  <Tooltip text={audioState.reason
    ?? `${audioState.moduleCount} audio module${audioState.moduleCount === 1 ? "" : "s"} on this slide. Browsers require a click before any page may make sound.`}>
    <button
      type="button"
      class="nf-audio-badge"
      class:nf-audio-failed={audioState.status === "failed"}
      disabled={audioState.status === "starting"}
      onclick={enableAudio}
    >
      <span class="nf-audio-dot" aria-hidden="true"></span>
      {LABELS[audioState.status]}
    </button>
  </Tooltip>
{/if}
