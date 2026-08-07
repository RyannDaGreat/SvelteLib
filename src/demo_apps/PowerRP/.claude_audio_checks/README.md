# Listen to the demo patches

Every demo audio patch, rendered offline and encoded so you can actually play it.
Regenerate with, from the repo root:

    node src/demo_apps/PowerRP/tests/renderPatchAudio.mjs

That writes `.wav` here (23 MB, **gitignored** — regenerable, too big to ship). The
`.mp3` files beside them are the same audio at 96 kbps and ARE committed, because
cloning this repo is the only way the user gets files.

## How it was rendered

The real blueprint through `buildPatchItems`, the real `readAudioScene`, the real
engine, in an `OfflineAudioContext` at 48 kHz in headless Chrome. **Not** a
re-implementation — if what you hear is wrong, the app is wrong the same way.
6 seconds per patch.

## Reading the filename tags

- `PENDING-n` — the patch still contains **n placeholder node types**. Placeholders
  declare no module, so `readAudioScene` skips them AND DROPS THEIR WIRES. Silence
  or a thin sound here may be unbuilt DSP rather than a defect.
- `NOEVENTS` — the patch is clock- or keyboard-driven, and you are hearing **its
  drones only**. The transport scheduler's look-ahead runs on a wall clock and an
  OfflineAudioContext's does not, so no sequenced events fire in this render. This
  is a limit of the renderer, not of the patch.

## Measured levels, 2026-08-07

| patch | peak |
|---|---|
| axo-shimmer | **+1.4 dBFS — CLIPPING** |
| axo-to-the-stars | **+0.1 dBFS — CLIPPING** |
| spacey-pad-drone | −0.2 |
| axo-radioactive | −0.8 |
| axo-tranquille | −0.9 |
| vcv-first-generative | −1.8 |
| vcv-granular-ambient | −6.9 |
| axo-strings-poly | −7.5 |
| beach | −10.5 |
| axo-pad3-plate | −11.2 |
| vcv-borealis | −15.7 |
| axo-drseq | −20.7 |
| whoosh | −24.7 |
| sequenced-dings, gamelan-bells, playable-keys, button-ding | silent (event-driven) |
| vcv-microcosm, vcv-ciani-buchla, vcv-ms20, axo-mi-stack | silent (placeholders) |

Two patches exceed 0 dBFS, i.e. their float samples go past ±1. The WAV writer
clamps rather than wrapping, so what you hear IS the clipping — that is deliberate:
a wrapped sample would turn a level defect into noise and hide which one it was.

## What this CANNOT tell you

Nothing here says a patch is FAITHFUL to the VCV Rack or Axoloti original. It says
what our port produces. Faithfulness needs an A/B against the upstream DSP, which
is a separate harness under `.frenzy/round7/faithfulness*/`.
