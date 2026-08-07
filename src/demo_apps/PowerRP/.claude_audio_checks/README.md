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

## Measured levels, 2026-08-07 (third render — after the knob-unit sweep)

`†` marks a patch whose knobs changed in that sweep: 89 harvested values that were raw
Axoloti dials, raw Rack knob positions, raw volts or enum indices sitting in knobs that
mean seconds, hertz or a named option. **Every peak that moved is in the table**, and all
four moved by design; the eleven patches the sweep did not touch are byte-for-byte where
they were, which is the control that says nothing else drifted.

| patch | peak | was |
|---|---|---|
| spacey-pad-drone | −0.2 | |
| axo-radioactive † | −1.0 | −0.8 |
| axo-to-the-stars | −0.9 | |
| vcv-first-generative | −1.8 | |
| axo-shimmer | −1.8 | |
| axo-tranquille † | −5.2 | −5.2 |
| axo-pad3-plate † | −5.2 | −5.2 |
| **axo-mi-stack** † | **−6.7** | **−3.9 — see below** |
| vcv-granular-ambient | −6.9 | |
| vcv-subharmonicon | −7.4 | |
| axo-strings-poly † | −7.5 | −7.5 |
| beach | −10.5 | |
| vcv-borealis † | −14.5 | −15.7 |
| vcv-incanta † | −17.8 | −19.1 |
| axo-drseq † | −20.7 | −20.7 |
| whoosh | −24.7 | |
| **vcv-fm-pad** | **−67.7 — audible only in name; see below** |
| sequenced-dings, gamelan-bells, playable-keys, button-ding | silent (event-driven) |
| vcv-microcosm, vcv-ciani-buchla, vcv-ms20 | silent (placeholders) |

**An earlier render had `axo-shimmer` at +1.4 dBFS and `axo-to-the-stars` at +0.1** —
past ±1, i.e. clipping. Both are fixed, and the three causes were three different
things worth knowing: shimmer's harvested `attenuate b: 15.5` is an FDN input drive
whose FDN the autoplay branch skips, so it landed undivided (fixed by restoring the
missing 1/15.5 trim, not by turning a knob down); to-the-stars shared one return-level
constant with two patches whose signal path is 2.6 dB colder; tranquille summed three
near-unison oscillators at unity and peaked at three. In two of the three, halving the
return moved the peak by well under a dB — a limiter answering, which is how you tell a
summing fault from a level fault.

**`vcv-fm-pad` at −67.7 dBFS is not a level to nudge — it is inaudible**, ~0.04% of
full scale. Treat it as a defect that has not been diagnosed yet, not as a quiet patch.

**`axo-mi-stack` moved 2.8 dB and the interesting part is that it first moved 21.** Its
two `dp_soft_clip` nodes held raw Axoloti dials — `ingain: 25`, i.e. a 100× drive into a
soft clipper, which is not a clipper at all but a squarer, followed by `outgain: 15` as
30× of make-up. Converting them to their real dial/64 values (0.390625 / 0.234375) dropped
the patch to −24.7 dBFS, because the autoplay return feeding them had been trimmed to 0.12
expressly to survive that 100× — its own comment said so. With the trim returned to unity
the patch sits at −6.7. **It gained 18.0 dB from 18.4 dB of knob, and that near-linearity
is the actual evidence the fix is right**: a shaper responding proportionally to its input
is one working in its cubic region, which is what an in-gain below unity is supposed to
produce. At the old 100× drive the same knob would have done almost nothing, because a
saturated clipper has no gain left to give.

**Three VCV patches are absent from the table because they do not BUILD**, and that is
older than this render: `vcv-ambient-drone`, `vcv-self-playing-ambient` and
`vcv-rampage-generative` each name a knob on a closed-source Vult/Instruō module
(`vessek`, `tangents`, `basal`) that the shipped spec does not have — 25 such names across
4 types, tracked by `.frenzy/round7/scratchpad_patch_reconcile.mjs`. Their knob-unit fixes
are in the source and unheard, and they stay unheard until those names resolve.

## What this CANNOT tell you

Nothing here says a patch is FAITHFUL to the VCV Rack or Axoloti original. It says
what our port produces. Faithfulness needs an A/B against the upstream DSP, which
is a separate harness under `.frenzy/round7/faithfulness*/`.
