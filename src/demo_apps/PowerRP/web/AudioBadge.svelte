<!--
  AudioBadge — the audio FAILURE surface, and nothing else.

  ── WHAT THIS USED TO BE, AND WHY IT ISN'T ──────────────────────────────────
  It used to render "audio off — click to enable" the moment a patch existed and the
  browser had not let the context start. USER RULING, 2026-08-06: "Of course I
  fucking want audio on. I always want audio on. Never make me ask that again. Get
  rid of that stupid ass button."

  THE BROWSER CONSTRAINT WAS NOT WHAT WAS OVERRULED. A page still needs a user
  gesture before it may make sound, and deleting this control naively would have
  made audio permanently unstartable, since its onclick was the only caller of
  engine.resume() in the repo. So the gesture is now harvested from one the user is
  already making — web/audioMirror.svelte.js `armAudioGesture` takes the next
  pointerdown or keydown anywhere in the app — and what died is the state that ASKS
  PERMISSION TO WANT SOUND.

  ── WHAT SURVIVES, AND WHY IT MUST ──────────────────────────────────────────
  `failed`. The no-silent-failure law binds absolutely: a synth engine that could
  not initialise (a worklet 404 under a changed base path is the common cause) or a
  resume() the browser refused outright presents as "everything is wired and nothing
  makes noise", which is indistinguishable from a bad patch. That is a real problem
  and it gets a real sentence, carried in `audioState.reason`.

  IT IS STILL A REAL BUTTON, and that is not a leftover. A failed start is RETRYABLE
  — the button acts, it does not merely report — so it must be reachable from the
  keyboard and must be a genuine gesture the browser will accept for the retry. That
  is the same distinction the toolbar draws between the save DOT (reports) and the
  save BUTTON (acts): a control that looks clickable and only reports would be a lie
  about its own affordance, and so would a real remedy hidden in a tooltip.

  `blocked` and `starting` render NOTHING. They are transient bookkeeping now: the
  first is resolved by the next touch of the app, the second by the promise already
  in flight.

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
</script>

{#if audioState.status === "failed"}
  <Tooltip text={`${audioState.reason ?? "the audio engine did not start"} — click to try again`}>
    <button type="button" class="nf-audio-badge nf-audio-failed" onclick={enableAudio}>
      <span class="nf-audio-dot" aria-hidden="true"></span>
      audio unavailable
    </button>
  </Tooltip>
{/if}
