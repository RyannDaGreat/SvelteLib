/**
 * THE VC-5 MODULE SPECS — nine ported VCV Rack modules: Valley's Plateau, Feline
 * and Terrorform, AlrightDevices' Chronoblob2, FrozenWasteland's JustAPhaser,
 * dbRackModules' SPF, repelzen's rewin and reburst, and Blamsoft's XFX F-35.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to a fourth module set, under the
 * PORT-BLOCK CONTRACT in core/audio_blocks.js. A spec is the values that make one
 * module differ from its neighbours and NOTHING about how it sounds. The DSP and
 * the R7-17 DERIVATION RECORDS — which C++ file, which commit, which recurrence,
 * which named deviation — are in `synth/vc5_kernels.js`, and each `help` below
 * points there rather than repeating it.
 *
 * THIS FILE MAY NOT IMPORT synth/** (core must run in bare node), so every option
 * list restated here is pinned against the kernels' own list by
 * tests/port_vc5_test.js — the same arrangement AX-2 and AX-3 use, for the same
 * reason: the dependency on the engine belongs in the test.
 *
 * ── UNITS: THE FOUR RULES, STATED IN THE KERNELS AND SUMMARISED HERE ────────
 * `synth/vc5_kernels.js`'s header is the authority. In short:
 *   V1  an `audio` port is ±1 and a Rack cable is ±5 V; the factor of five is
 *       applied at the kernel boundary and nowhere else.
 *   V2  a `number` port carries REAL UNITS, never volts. So every Rack
 *       attenuverter is GONE: a modulation input has the same units and the same
 *       name as the knob it sums with. Twelve of Plateau's twenty-nine params and
 *       ten of Feline's seventeen were attenuverters; they were unit conversions
 *       and the unit is now written on the row.
 *   V3  a module's own DIAL RANGE is kept verbatim (Plateau's Decay really is
 *       0.1..0.9999, Feline's Cutoff really is 0..10, SPF's Freq really is 4..14),
 *       so a param value out of a `.vcv` file transfers unchanged. Panel tapers
 *       are reproduced inside the kernel. THE ONE EXCEPTION is Chronoblob2, whose
 *       taper is behind a closed binary — its `time` is in SECONDS and its dial
 *       values do NOT transfer. Its help says so.
 *   V6  A MODULATION OUTPUT CARRIES ITS REAL UNIT, NOT A DIVIDED VOLTAGE — the
 *       lead's worked example of clause 2 (2026-08-06). Terrorform's `env` and
 *       `phasor` are 0..1, not the 0..2 that clause 1's divide-by-five would give
 *       their 0..10 V Rack outputs: they are not audio, and putting a normalised
 *       control signal outside the 0..1 every other normalised control in this
 *       library uses would double what an author's depth knob shows.
 *   V5  a `gate`/`trigger` port carries 0..1, NOT volts / 5 — R7-UNITS clause 4.
 *       Clause 1 is about LEVEL and logic is not level. In this block that is
 *       Chronoblob2's `sync` (its whole clock-sync behaviour hangs off it),
 *       reburst's `gate`/`clock`/`gate_out`/`eoc`, Plateau's `freeze`/`clear` and
 *       Terrorform's `trigger`/`sync`/`eoc`.
 *   V4  a PITCH port carries SEMITONES, ORIGIN C4 (`semitones = 12 x volts`) —
 *       THE LEAD'S R7-UNITS RULING. Both sides, so a quantiser's output lands in
 *       an oscillator's `v_oct` at the same scale instead of silently detuning
 *       every patch. ⚠ The origin is C4 (261.6256 Hz), NOT the E4 that
 *       `core/audio_nodes.semitonesToHz` assumes for the Axoloti blocks — reusing
 *       that converter on a VCV card would read four semitones sharp, so this
 *       file does not import it and `synth/vc5_kernels.vcvSemitonesToHz` is the
 *       C4-origin one.
 *
 * ── ⚠ NO KNOB IN THIS BLOCK DECLARES `hz`, AND THAT IS A SEAM LIMIT ─────────
 * Every tuning control here WOULD benefit from one: Valley's dials are 0..10 with
 * `440·2^(dial − 5)` behind them, JustAPhaser's and SPF's are `2^dial`, and a bare
 * `6.31` on a card is exactly the unreadable control the lead's 2026-08-06 ruling
 * is about. So the frequency is written into every one of those knobs' `help`
 * instead (dial 5 is A440, dial 0 is 13.75 Hz, dial 10 is 14080 Hz), which is the
 * best this block can currently do.
 *
 * WHY NOT THE `hz` FIELD: `tests/audio_nodes_test.js`'s sweep asserts that every
 * knob's `hz` equals `core/audio_nodes.semitonesToHz` times a per-TYPE scalar
 * ratio from a whitelist. That encodes "this library has ONE tuning law and it is
 * Axoloti's E4 semitone law", which was true when only the AX blocks existed. A
 * VCV octave dial is not a scalar multiple of a semitone law — it is a different
 * exponent base with a different origin — so no ratio can be declared that would
 * satisfy it, and shipping an `hz` here reddens a suite this block does not own.
 * THE SEAM CHANGE THAT WOULD FIX IT (reported to the lead, not applied here):
 * the whitelist's value needs to become the CONVERTER rather than a ratio, so a
 * spec can name its own tuning law and be held to it. Then every dial below can
 * read out its hertz.
 *
 * ── TWO OF THE NINE ARE BEHAVIOUR-DERIVED AND THEIR HELP SAYS SO FIRST ──────
 * Chronoblob2 and XFX F-35 have no published source — the VCV library manifests
 * carry no `sourceUrl` and both vendors ship binaries. They are ported from their
 * own documentation and each spec's `derivation.kind` is `"behaviour"` rather than
 * `"source"`, which tests/port_vc5_test.js asserts. An author must be able to see
 * that difference without reading the kernels, so it is in the `help` too.
 */

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/**
 * VALLEY'S DAMPING DIAL — 0..10, where `440 * 2^(dial - 5)` hertz. Dial 5 is
 * A440, dial 0 is 13.75 Hz and dial 10 is 14080 Hz, so ten notches span the whole
 * audible range in OCTAVES (not Axoloti's semitones). `hz` is the lead's
 * 2026-08-06 ruling applied here for the same reason it applies to AX-3: a dial
 * number with no frequency shown is a control the author cannot reason about.
 */
const VALLEY_DIAL = { min: 0, max: 10, step: 0.01, unit: " oct" };

/** Plateau's four damping dials are offset by +5 inside the kernel and two of them
 *  are REVERSED, so the frequency behind the dial is not `VALLEY_DIAL`'s. Stated
 *  per row rather than shared, because sharing a wrong conversion is worse than
 *  omitting one. */
const PLATEAU_DAMP_HIGH = { min: 0, max: 10, step: 0.01 };
const PLATEAU_DAMP_LOW = { min: 0, max: 10, step: 0.01 };

/** An "off"/"on" panel switch. Discrete rather than 0/1 numeric so the Inspector
 *  row reads as a switch and an equation can still write it. */
const SWITCH = { discrete: true, options: ["off", "on"] };

/** A 0..1 fraction: a mix, a depth, a level. */
const UNIT = { min: 0, max: 1, step: 0.01 };

/**
 * THE SEED KNOB — D0, the project's determinism law. Two of these nine read a
 * host RNG in their original: `Shaper::warble` seeds from `std::time(NULL)` and
 * `reburst`'s jitter and four random CV modes call `rack::random::uniform()`.
 * Neither is reproducible even on the same machine, and a document that renders
 * differently every time is not a document. Copied from AX-2's SEED, which is the
 * precedent this project set.
 */
const SEED = {
  key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
  help: "CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. THE REASON THIS KNOB EXISTS: the original reads the host's random source and is not reproducible even on the same machine, and PowerRP's determinism law (CLAUDE.md, 'The three kinds of state') says Δt = 0 must give a byte-identical frame. Same seed, same randomness, forever.",
};

// ── EFFECTS ─────────────────────────────────────────────────────────────────

export const VCV_PLATEAU_SPEC = {
  type: "audio_vcv_plateau", module: "vcvPlateau", title: "Plateau", family: "effect",
  icon: "mdi:blur", readout: "decay", w: 190,
  help: "Valley's PLATEAU — a Dattorro (1997) figure-of-eight plate reverb, and the single most-used module in the surveyed VCV patch set: twenty-one of twenty-five end in it. Its character is not a wet knob on a generic Schroeder tank; it is eight specific delay lengths, an input diffuser that can be switched out, damping filters INSIDE the recirculating loop and four slow triangle LFOs modulating the tank's allpasses. MONO IN, STEREO OUT: the two inputs are summed and the stereo image is manufactured by the tank's asymmetry. Full derivation, including the 44.1 kHz tank clamp that is a source bug worth knowing about, in synth/vc5_kernels.js.",
  inputs: [
    { key: "in_l", type: "audio", label: "in L" },
    { key: "in_r", type: "audio", label: "in R" },
    { key: "dry", type: "number", label: "dry" },
    { key: "wet", type: "number", label: "wet" },
    { key: "pre_delay", type: "number", label: "pre" },
    { key: "input_low_damp", type: "number", label: "in lo" },
    { key: "input_high_damp", type: "number", label: "in hi" },
    { key: "size", type: "number", label: "size" },
    { key: "diffusion", type: "number", label: "diff" },
    { key: "decay", type: "number", label: "decay" },
    { key: "reverb_low_damp", type: "number", label: "rv lo" },
    { key: "reverb_high_damp", type: "number", label: "rv hi" },
    { key: "mod_speed", type: "number", label: "rate" },
    { key: "mod_shape", type: "number", label: "shape" },
    { key: "mod_depth", type: "number", label: "depth" },
    { key: "freeze", type: "trigger", label: "hold" },
    { key: "clear", type: "trigger", label: "clear" },
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "out L" },
    { key: "out_r", type: "audio", label: "out R" },
  ],
  knobs: [
    { key: "dry", label: "Dry", default: 1, ...UNIT, help: "How much of the input passes through unprocessed." },
    { key: "wet", label: "Wet", default: 0.5, ...UNIT, help: "Reverb level. It is multiplied by TEN inside, which is what cancels the −20 dB the tank input is driven at — so 1.0 is roughly unity, not ten times too loud." },
    { key: "pre_delay", label: "Pre-delay", default: 0, min: 0, max: 0.5, step: 0.001, unit: " s", help: "Silence before the first reflection. The single most effective way to keep a reverb from swallowing a transient: 40 ms of pre-delay lets the attack through before the tail starts. Modulation can push it to 1 s; the dial stops at 0.5." },
    { key: "input_high_damp", label: "Input high cut", default: 10, ...PLATEAU_DAMP_HIGH, help: "A one-pole lowpass BEFORE the tank. The dial is offset by +5 inside, so its top half is flat at 14 kHz and all the useful travel is in the bottom half." },
    { key: "input_low_damp", label: "Input low cut", default: 10, ...PLATEAU_DAMP_LOW, help: "A one-pole highpass before the tank, and its dial is REVERSED: 10 is 13.75 Hz (no cut) and 0 is 440 Hz (the most). Turning it up opens the bottom end. Theirs." },
    { key: "size", label: "Size", default: 0.5, ...UNIT, help: "Scales all eight tank delays together. SQUARE-LAW, so the bottom half of the dial is small rooms and the top half opens right up — measured RT60 at the default decay: 0.2 s at size 0.05, 5.5 s at 0.5, 16 s at 0.9. With Tuned on it becomes an exponential 0.0025..2.5 and the tank rings as a resonator instead of sizing as a room." },
    { key: "diffusion", label: "Diffusion", default: 10, min: 0, max: 10, step: 0.01, help: "The four tank allpass gains, 0 to ±0.7. At 0 the tank is four bare delay lines and you hear discrete slapback; at 10 the echoes smear into a wash. Note the SIGN SPLIT: the first allpass of each half gets −gain and the second +gain, which is what decorrelates them." },
    { key: "decay", label: "Decay", default: 0.54995, min: 0.1, max: 0.9999, step: 0.0001, help: "Tank loop gain, through `1 − (1 − dial)²` — so the top few percent of the dial is where the near-infinite tails live. Measured RT60 at size 0.5: 1.5 s at 0.2, 5.5 s at 0.55, 16 s at 0.9." },
    { key: "reverb_high_damp", label: "Reverb high cut", default: 10, ...PLATEAU_DAMP_HIGH, help: "A lowpass INSIDE the recirculating loop, so it darkens each pass rather than the output once. That is what makes a plate sound like a room instead of like a delay through an EQ." },
    { key: "reverb_low_damp", label: "Reverb low cut", default: 10, ...PLATEAU_DAMP_LOW, help: "A highpass inside the loop, dial REVERSED like the input one. Use it to stop a long tail from building up mud." },
    { key: "mod_speed", label: "Mod rate", default: 0, ...UNIT, help: "How fast the four tank LFOs run, SQUARED then mapped to 1×..100× of their base 0.10 / 0.15 / 0.12 / 0.18 Hz. Their RATIOS never change, so the beat pattern between them — which is the shimmer — is the same at every rate." },
    { key: "mod_depth", label: "Mod depth", default: 0.5, min: 0, max: 16, step: 0.01, unit: " smp", help: "How far the LFOs move the tank's two allpass delays, in SAMPLES. Even one sample is audible as a slow chorus on a long tail; 16 is a seasick warble. At 0 a long decay rings on a fixed comb and sounds metallic." },
    { key: "mod_shape", label: "Mod shape", default: 0.5, ...UNIT, help: "The LFOs' triangle reversal point. 0.5 is a symmetric triangle; near 0 a falling saw, near 1 a rising one — so the pitch wobble becomes one-directional." },
    { key: "hold", label: "Hold", default: "off", ...SWITCH, help: "Freeze: loop gain becomes exactly 1 and the damping filters fade OUT of the loop over one second, so a frozen tank stops losing highs as well as stops decaying. The `hold` input ORs with this. THIS IS A KNOB AND NOT A BUTTON ON PURPOSE — Rack's is a momentary press plus a separate toggle-mode switch, and a momentary press is not property state; here the latch itself is keyframable, one state per slide." },
    { key: "tuned", label: "Tuned", default: "off", ...SWITCH, help: "Remaps Size to an exponential 0.0025..2.5 so the tank can be PLAYED — at small sizes it rings at a pitch you can tune. Turns the reverb into a resonator." },
    { key: "diffuse", label: "Diffuse input", default: "on", ...SWITCH, help: "The four-stage Schroeder diffuser in front of the tank (141, 107, 379, 277 samples at Dattorro's 29761 Hz). Off, transients arrive at the tank intact and the early reflections are discrete — which is what you want for a rhythmic source." },
    { key: "sensitivity", label: "Input level", default: "0dB", discrete: true, options: ["0dB", "-18dB"], help: "Their context-menu input trim. −18 dB keeps a hot modular signal out of the tank's nonlinearity; 0 dB is the default and the louder, dirtier one." },
    { key: "saturate", label: "Output drive", default: "off", ...SWITCH, help: "Replaces the ±10 V output clamp with Valley's piecewise saturator at 0.111 pre-gain and 9.999 post-gain — so instead of clipping flat, a loud tail compresses. Their context-menu option." },
  ],
  derivation: {
    kind: "source",
    source: "ValleyAudio/ValleyRackFree src/Plateau/{Plateau,Dattorro}.cpp, model Plateau @ 86f02e431136a7f5c96a872b99b7115b7e133e05",
    block: "Plateau::getParameters + Plateau::process (the tapers); Dattorro::process (the input chain); Dattorro1997Tank::process + ::tickApfModulation (the tank)",
    recurrence: "See synth/vc5_kernels.js DattorroTank, DattorroReverb and PlateauKernel docblocks — the full recurrence, the eight delay lengths, the seven shared output taps and the tapers are written out there in float.",
    deviations: [
      "D-TANKRATE: the tank clamps ITSELF to 44100 Hz because `maxSampleRate` is a field initialiser the constructor never assigns. At a 48 kHz engine the plate is 8.8% small and bright. Reproduced — this is what Plateau sounds like in Rack at 48 kHz.",
      "D-TANKFILTERRATE: the tank's four damping filters never receive a sample rate and stay at the default 44100. Reproduced.",
      "D-LFOPHASE: the constructor spreads the four tank LFOs 90 degrees apart but `TriSawLFO::process` never reads `phase`, so they all start together. Reproduced.",
      "D-FADETIME: the freeze crossfade is 1 second, not the 2 ms the header's field initialiser suggests — `setSampleRate` overwrites it. Reproduced.",
      "D-HOLDSTATE: the momentary Hold button plus toggle-mode switch become one `hold` knob, because a momentary press is not property state and a keyframable latch is strictly more expressive.",
      "D-CLEARTRIG: Clear is a trigger port only; its 4 ms fade-out / clear / fade-in envelope is reproduced exactly because it also scales the dry path.",
      "D-NOCV: twelve CV attenuverters removed per V2 — a modulation input carries the knob's own units.",
      "D-HPCLAMP: our one-pole highpass floors at 1 Hz where theirs would assert; unreachable in practice, the dial's floor is 13.75 Hz.",
      "D-PANELSTYLE: panel and display styles are cosmetic and not ported.",
    ],
  },
};

export const VCV_CHRONOBLOB2_SPEC = {
  type: "audio_vcv_chronoblob2", module: "vcvChronoblob2", title: "Chronoblob 2", family: "effect",
  icon: "mdi:blur-linear", readout: "time", w: 180,
  help: "AlrightDevices' CHRONOBLOB 2 — a clock-syncable stereo delay, in sixteen of the twenty-five surveyed patches. ⚠ THIS PORT IS BEHAVIOUR-DERIVED: the plugin is CLOSED SOURCE (no `sourceUrl` in its VCV manifest; the author ships binaries), so it is built from the published manual and the panel state recovered from the patch files, not from code. What that costs you is stated on the Time knob. What is faithful is the part the manual is explicit about and that the patches depend on: TAPE mode really resamples, so changing the delay time pitch-bends the repeats the way a tape or BBD does — measured here at a 25% upward bend when the time halves. See synth/vc5_kernels.js for the three things the documents do not establish.",
  inputs: [
    { key: "in_l", type: "audio", label: "in L" },
    { key: "in_r", type: "audio", label: "in R" },
    { key: "fb_return", type: "audio", label: "fb ret" },
    { key: "time", type: "number", label: "time" },
    { key: "feedback", type: "number", label: "fb" },
    { key: "mix", type: "number", label: "mix" },
    { key: "damp", type: "number", label: "damp" },
    { key: "sync", type: "trigger", label: "sync" },
    { key: "hold", type: "trigger", label: "hold" },
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "out L" },
    { key: "out_r", type: "audio", label: "out R" },
    { key: "fb_send", type: "audio", label: "fb snd" },
  ],
  knobs: [
    { key: "time", label: "Time", default: 0.25, min: 0.001, max: 10, step: 0.001, unit: " s", help: "Delay time in SECONDS — and this is the one control in this block whose value does NOT transfer from a `.vcv` patch. The original's dial is normalised 0..1 over an undocumented range with an undocumented taper, and the taper is behind a closed binary, so a saved 0.3005 is 30% of something unknown. A real unit is the honest alternative to a guessed curve. When `sync` is patched this knob is ignored and `division` takes over." },
    { key: "feedback", label: "Feedback", default: 0.4, min: 0, max: 1.25, step: 0.01, help: "Repeats. The manual's ceiling is 125% and it is kept: above 1.0 the loop GROWS, which is the point — that is where a delay becomes a drone machine. Hold locks it at exactly 1." },
    { key: "mix", label: "Mix", default: 0.5, ...UNIT, help: "Dry to wet." },
    { key: "damp", label: "Damping", default: 20000, min: 20, max: 20000, step: 1, unit: " Hz", help: "A one-pole lowpass in the FEEDBACK path, so each repeat is darker than the last. DEFAULTS TO FULLY OPEN, i.e. off — because whether the original filters its feedback, and how, is NOT in its documentation, and the only behaviour that can be defended from the documents is an unfiltered loop. The control exists because a delay without one is a worse instrument, not because the original is known to have it." },
    { key: "mode", label: "Mod mode", default: "tape", discrete: true, options: ["tape", "fade"], help: "THE THING THE MANUAL IS CLEAREST ABOUT AND THE REASON THIS MODULE SOUNDS LIKE ITSELF. `tape` resamples: the read head slews to a new position, so a change in delay time is a PITCH BEND, exactly as a tape loop or a BBD does it. `fade` crossfades between taps over 20 ms instead — clean, unpitched, and what you want when the time is sequenced." },
    { key: "delay", label: "Topology", default: "dual", discrete: true, options: ["dual", "ping_pong", "single", "cascade"], help: "`dual` is two independent delays sharing the controls. `ping_pong` cross-couples them so a mono input walks across the image. `single` is one delay whose feedback loop leaves at `fb send` and returns at `fb ret`, so you can put anything inside it. `cascade` puts delay 2 INSIDE delay 1's loop, which multiplies the two times into a rhythm rather than adding them into a longer echo." },
    { key: "division", label: "Sync division", default: "1", discrete: true, options: ["1/16", "1/12", "1/8", "1/6", "1/4", "1/3", "1/2", "2/3", "1", "3/2", "2", "3", "4", "6", "8", "16"], help: "The clock ratio the delay locks to when `sync` is patched. Triplet and dotted values are here because a delay that can only do powers of two cannot play against a swung sequence. Verified: a 2 Hz clock at ratio 1 gives a 0.5000 s echo." },
    { key: "prescaler", label: "Clock ÷", default: 1, min: 1, max: 96, step: 1, help: "How many `sync` pulses make one measured period. A patch stored `sync_prescaler: 6`, which is a sane value for a 24-pulse-per-quarter clock — but the manual does not document the field's units, so this reading is inferred and flagged rather than asserted." },
  ],
  derivation: {
    kind: "behaviour",
    source: "AlrightDevices/Chronoblob2 — CLOSED SOURCE, no sourceUrl in VCVRack/library manifests/AlrightDevices.json. Documents: docs.alrightdevices.com/chronoblob2-manual.pdf (User Manual v1.3); library.vcvrack.com/AlrightDevices/Chronoblob2; the .vcv panel state recorded in .frenzy/round7/survey_vcv.md for P20 (delay_mode 1, hold_behavior 0, sync_prescaler 6)",
    block: "N/A — no code was read. The manual's control-by-control description and its statement that TAPE mode resamples while FADE crossfades.",
    recurrence: "See synth/vc5_kernels.js Chronoblob2Kernel — the read-head slew that IS the tape pitch shift, the four topologies and the clock measurement are written out there.",
    deviations: [
      "U1: the delay time range and taper are UNKNOWN. The `time` knob is in seconds and a raw .vcv dial value cannot be transferred to it. Every other node in this block transfers verbatim; this one does not.",
      "U2: whether the feedback path is filtered is UNKNOWN. `damp` defaults to fully open, so the DEFAULT behaviour is the one the documents support.",
      "U3: the sync prescaler's units are UNDOCUMENTED. Ported as pulses-per-period.",
      "D-CB-SNAP: the feedback knob's snap-to-100% detent is a knob behaviour, not a DSP one, and our fields take equations. Type `= 1` for exactly 100%.",
      "D-CB-SEND: `single` mode's external send/return pair exists as ports in every mode rather than appearing with the mode, because a port that comes and goes is not expressible in a spec.",
      "D-NOCV: per V2, and with it the manual's quirk that the Time CV input is normalled to 5 V so its attenuverter offsets the main knob. Our `time` input reads 0 when unpatched.",
      "TAPE_SLEW is 0.25 s of delay time per second of real time. UNVERIFIED against the original — it sets how far the pitch bends and the documents give no figure.",
    ],
  },
};

export const VCV_JUSTAPHASER_SPEC = {
  type: "audio_vcv_justaphaser", module: "vcvJustaphaser", title: "Just A Phaser", family: "effect",
  icon: "mdi:waves", readout: "center_frequency", w: 185,
  help: "FrozenWasteland's JUST A PHASER — 4, 8 or 12 stages with a per-stage frequency profile, four modulation-span shapes and an external feedback loop. THREE OF ITS SOURCE BUGS ARE REPRODUCED AND NAMED, because they are what it sounds like: half its stage-offset table is C++ integer division (so the four-stage profile notches at exactly 2 and 4 octaves rather than 2.917 and 4.167 — measured here at 70, 197, 256 and 1024 Hz), its filter-type switch is wired backwards against its own panel lights, and its allpass coefficients are computed in the wrong units with Q on the wrong side of the divide, which is why the allpass mode barely sweeps. Read synth/vc5_kernels.js before 'fixing' any of it.",
  inputs: [
    { key: "in_l", type: "audio", label: "in L" },
    { key: "in_r", type: "audio", label: "in R" },
    { key: "fb_in_l", type: "audio", label: "fb L" },
    { key: "fb_in_r", type: "audio", label: "fb R" },
    { key: "external_mod_l", type: "number", label: "mod L" },
    { key: "external_mod_r", type: "number", label: "mod R" },
    { key: "frequency", type: "number", label: "rate" },
    { key: "depth", type: "number", label: "depth" },
    { key: "feedback", type: "number", label: "fb" },
    { key: "center_frequency", type: "number", label: "centre" },
    { key: "frequency_span", type: "number", label: "span" },
    { key: "resonance", type: "number", label: "reso" },
    { key: "stereo_phase", type: "number", label: "spread" },
    { key: "mix", type: "number", label: "mix" },
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "out L" },
    { key: "out_r", type: "audio", label: "out R" },
    { key: "fb_out_l", type: "audio", label: "send L" },
    { key: "fb_out_r", type: "audio", label: "send R" },
  ],
  knobs: [
    { key: "frequency", label: "Mod rate", default: 0, min: -8, max: 3, step: 0.01, unit: " oct", help: "The sweep LFO, as a power of two in hertz: 0 is 1 Hz, 3 is 8 Hz and −8 is one cycle every four minutes. A modulation input can push it to their internal ceiling of 8 (256 Hz), which is audio rate and turns the phaser into a ring modulator." },
    { key: "depth", label: "Mod depth", default: 0.5, ...UNIT, help: "How far the LFO moves each stage, scaled per stage by the `span` profile." },
    { key: "feedback", label: "Feedback", default: 0, min: -1, max: 1, step: 0.01, help: "Resonance around the whole stage chain. NEGATIVE feedback is a different sound, not less of the same one: it inverts which frequencies reinforce, so the notches become peaks." },
    { key: "center_frequency", label: "Centre", default: 8, min: 4, max: 14, step: 0.01, unit: " oct", help: "Where the notch comb sits, as a power of two in hertz MINUS TWO — their `centerFrequency - 2.0` with the comment 'temporary', still there and part of the tuning. So 8 means the first stage sits near 2^6 = 64 Hz." },
    { key: "frequency_span", label: "Span", default: 1, min: 0.01, max: 1, step: 0.01, help: "Scales the per-stage OFFSETS, so it squeezes the whole comb toward the centre frequency. At 0.01 every stage lands almost on top of the others and the phaser becomes a single deep notch." },
    { key: "resonance", label: "Resonance", default: 0.707, min: 0.5, max: 5, step: 0.001, help: "Each stage's Q. In notch mode this narrows the notches. In allpass mode it BROADENS them — Q is multiplied where the cookbook divides (a source bug, named D-JAP-ALLPASS)." },
    { key: "stereo_phase", label: "Stereo spread", default: 0.25, min: 0, max: 0.99999, step: 0.00001, unit: " cyc", help: "How far the right channel's LFO lags the left, in cycles. 0.25 is a quarter turn and is the classic wide sweep; 0 makes the phaser mono." },
    { key: "mix", label: "Mix", default: 0.5, ...UNIT, help: "Dry to phased. A phaser at 0.5 is where the notches are deepest, because it is the cancellation between the two paths that makes them." },
    { key: "stages", label: "Stages", default: "4", discrete: true, options: ["4", "8", "12"], help: "Each count has its OWN offset profile, so this is not just more of the same — 4 is the classic wide sweep, 12 is a dense comb. The profiles are half integer division in the source (D-JAP-INTDIV) and are reproduced as-is." },
    { key: "filter", label: "Filter", default: "notch", discrete: true, options: ["notch", "allpass"], help: "THESE NAMES FOLLOW THE SOUND, NOT THE PANEL LIGHT. The source's enum and lights say mode 0 is allpass, but the code installs a NOTCH for mode 0 — so a patch storing `filterMode: 0` gets a notch, and so does this option. `notch` is the deep, obvious phaser; `allpass` barely moves, for the reason named in D-JAP-ALLPASS." },
    { key: "wave", label: "LFO wave", default: "sin", discrete: true, options: ["sin", "tri", "saw", "sqr"], help: "`saw` gives the one-directional sweep a phaser is often wanted for. `sqr` is UNIPOLAR 0/1 and, because the right channel's phase offset can push it past 1, is low for most of that channel's cycle — theirs, reproduced." },
    { key: "span", label: "Mod profile", default: "log", discrete: true, options: ["log", "constant", "alt_log", "alt_constant"], help: "How the modulation depth is distributed across the stages. `log` sweeps the low stages further than the high ones, so the comb stretches. `constant` moves them all together. The `alt_` variants NEGATE every other stage, so adjacent notches cross instead of moving in parallel — that is the widest, most liquid setting." },
  ],
  derivation: {
    kind: "source",
    source: "almostEric/FrozenWasteland src/JustAPhaser.cpp + src/filters/biquad.cpp, model JustAPhaser @ 608d49dc365eb2fd4734e58ee5fd356ce03919ff",
    block: "JustAPhaser::process, the basefreq/basespan tables in the struct body, LowFrequencyOscillator, and Biquad::calcBiquad's notch and allpass branches",
    recurrence: "See synth/vc5_kernels.js JustAPhaserKernel and EarLevelBiquad.",
    deviations: [
      "D-JAP-INTDIV: `basefreq` mixes double and INTEGER division — `35 / 12` is 2 and `7 / 12` is 0 in C++. So the four-stage profile is {0.125, 1.625, 2, 4} octaves, not the intended {0.125, 1.625, 2.917, 4.167}, and one twelve-stage entry sits exactly on the centre frequency. Reproduced; measured notches at 70, 197, 256 and 1024 Hz confirm it.",
      "D-JAP-MODEINVERT: `setType(filterMode ? allpass : notch)` contradicts the enum and the panel lights. Reproduced, and our option names follow the sound so a stored integer still selects the same filter.",
      "D-JAP-ALLPASS: the allpass branch computes `sin(Fc)` and `cos(Fc)` on a NORMALISED frequency as though it were radians, and multiplies by Q where the cookbook divides. Two bugs in one line, both audible as an allpass mode that barely sweeps. Reproduced.",
      "D-JAP-FCTHRESHOLD: a stage's coefficients are only recomputed when its target moves more than 0.01 octaves — a quantiser on the sweep, audible as fine stepping. Reproduced.",
      "D-JAP-EXTMOD: `lfoValue = extMod/5 - 1`, so a 0 V external modulator parks the sweep fully down rather than centred. Reproduced.",
      "D-JAP-SQR: the square LFO is unipolar 0/1 and asymmetric between channels. Reproduced.",
      "D-NOCV: per V2.",
    ],
  },
};

// ── FILTERS ─────────────────────────────────────────────────────────────────

export const VCV_FELINE_SPEC = {
  type: "audio_vcv_feline", module: "vcvFeline", title: "Feline", family: "filter",
  icon: "mdi:cat", readout: "cutoff", w: 175,
  help: "Valley's FELINE — a stereo zero-delay-feedback OTA ladder with a saturator INSIDE every integrator, which is what makes it change character under drive instead of just clipping. Two switches choose the tap mix (2 or 4 poles, lowpass or bandpass) and SPACING splits the two channels' cutoffs apart, which is the module's own trick: one filter that is also a stereo widener. Measured: exactly −24 dB/octave at four poles, −3 dB at the dial's own frequency, self-oscillating at resonance 10. Derivation in synth/vc5_kernels.js.",
  inputs: [
    { key: "in_l", type: "audio", label: "in L" },
    { key: "in_r", type: "audio", label: "in R" },
    { key: "cutoff", type: "number", label: "cutoff" },
    { key: "resonance", type: "number", label: "reso" },
    { key: "drive", type: "number", label: "drive" },
    { key: "spacing", type: "number", label: "space" },
    { key: "spacing_target", type: "number", label: "target" },
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "out L" },
    { key: "out_r", type: "audio", label: "out R" },
    { key: "sum", type: "audio", label: "sum" },
  ],
  knobs: [
    { key: "cutoff", label: "Cutoff", default: 10, ...VALLEY_DIAL, help: "Their 0..10 dial: `440 · 2^(dial − 5)` hertz, so ten notches span 13.75 Hz to 14 kHz in whole octaves. A modulation depth of 1 is therefore always one octave, wherever the dial is parked." },
    { key: "resonance", label: "Resonance", default: 0, min: 0, max: 10, step: 0.01, help: "Ladder feedback: `k = 0.4 × dial`, so the dial's top gives k = 4 — the classic four-pole self-oscillation threshold. At 8 the filter rings; at 10 it sings on its own." },
    { key: "drive", label: "Drive", default: 0, ...UNIT, help: "Input gain into the saturating stages, SQUARED then mapped to 0.75×..10× — so its floor actually attenuates slightly and most of the travel is in the top half. Because the nonlinearity is inside the integrators, driving it does not just distort: it moves the effective cutoff." },
    { key: "spacing", label: "Spacing", default: 0, min: -1, max: 1, step: 0.01, unit: " oct", help: "How far apart the two channels' cutoffs sit, in octaves. Non-zero and the filter becomes a stereo widener — the same signal filtered two ways is wide in a way panning is not." },
    { key: "spacing_target", label: "Spacing mode", default: 0, ...UNIT, help: "How the spacing is distributed. At 0 only the RIGHT channel moves (their `linterp(0, −spacing, target)`); at 1 the two split symmetrically about the dial. Continuous between, because it is a slider on the panel." },
    { key: "poles", label: "Poles", default: "4", discrete: true, options: ["2", "4"], help: "Two poles is −12 dB/octave, four is −24. Four is also where the resonance can self-oscillate." },
    { key: "type", label: "Type", default: "lowpass", discrete: true, options: ["lowpass", "bandpass"], help: "ONLY LOWPASS AND BANDPASS, AND THAT IS THE MODULE. The filter underneath also has HP2 and HP4 tap mixes, but Feline's panel computes `mode = poles + type·2` from two two-position switches and can only ever reach 0..3 — so its highpasses are unreachable in Rack too." },
  ],
  derivation: {
    kind: "source",
    source: "ValleyAudio/ValleyRackFree src/Feline/Feline.cpp + src/dsp/filters/VecOTAFilter.{hpp,cpp}, model Feline @ 86f02e431136a7f5c96a872b99b7115b7e133e05",
    block: "VecOTAFilter::process (the ladder), ::setCutoff (the g table), ::setQ, ::setMode (the four reachable tap mixes), Feline::step (the panel)",
    recurrence: "See synth/vc5_kernels.js FelineKernel and OtaOnePoleStage.",
    deviations: [
      "D-GTABLE: their `g` and `1/(1+g)` come from two 1.1-million-entry tables at 100000 entries per octave. We compute `tan` and the reciprocal directly — below float32's own resolution, so slightly more accurate and 8.8 MB lighter per instance.",
      "D-FLOAT: theirs is float32 SIMD, ours float64 scalar. MEASURED, and the measurement CORRECTED THIS SENTENCE — it used to say the difference 'compounds' in a feedback structure, which was reasoned rather than measured. Against a Math.fround model of our own recurrence at resonance 8 (k = 3.2, near self-oscillation) the worst absolute divergence over 4096 samples is 1.2e-8, i.e. 0.001% of the signal's RMS: the saturators bound the loop, so single precision does NOT accumulate here. tests/port_vc5_test.js prints the figure and fails if the two stop being the same recurrence.",
      "D-SUMOUT: their third output is `(l + r) × 2.5` against `× 5` for the mains — i.e. the MEAN, not the sum. Reproduced.",
      "D-NOCV: ten CV inputs with ten attenuverters become five modulation inputs in the knobs' own units, per V2.",
      "The two highpass tap mixes are not shipped because the panel cannot select them — see the Type knob's help.",
    ],
  },
};

export const VCV_SPF_SPEC = {
  type: "audio_vcv_spf", module: "vcvSpf", title: "SPF", family: "filter",
  icon: "mdi:call-split", readout: "freq",
  help: "dbRackModules' SPF — Victor Lazzarini's Csound state-space filter: ONE resonant pole pair with THREE separate numerators, so a lowpass, a bandpass and a highpass input feed the same resonance. Patch the same signal into all three and you get a morphing filter with no morph knob; patch three different signals and you get three filters that share a resonance. Measured: −12 dB/octave lowpass, unity bandpass at centre, and a Q of 100 at the top of the R dial. Derivation in synth/vc5_kernels.js.",
  inputs: [
    { key: "lp", type: "audio", label: "lp" },
    { key: "bp", type: "audio", label: "bp" },
    { key: "hp", type: "audio", label: "hp" },
    { key: "freq", type: "number", label: "freq" },
    { key: "r", type: "number", label: "R" },
  ],
  outputs: [{ key: "cv", type: "audio", label: "out" }],
  knobs: [
    { key: "freq", label: "Frequency", default: 10, min: 4, max: 14, step: 0.01, unit: " oct", help: "Their dial, as a power of two in hertz: 10 is 1024 Hz, 4 is 16 Hz, 14 is 16384 Hz. Clamped inside to [2 Hz, 0.33 × sample rate] — deliberately well below Nyquist, because the bilinear `tan` prewarp blows up approaching it." },
    { key: "r", label: "Resonance", default: 1, min: 0, max: 2, step: 0.01, help: "INVERTED: R in the denominator is `2 − dial`, so 0 is critically over-damped with no resonance at all and the top is a Q of 100 that self-oscillates. Their clamp stops at 1.999, so the last 0.001 of the declared range does nothing — both quirks are theirs." },
  ],
  derivation: {
    kind: "source",
    source: "docb/dbRackModules src/SPF.cpp, model SPF @ fa15d1b708e1e27f560a2bc0788888b9d80a4bfc. The file credits the algorithm: 'taken from csound Copyright (c) Victor Lazzarini, 2021'",
    block: "SPFFilter<T>::process and SPF::process",
    recurrence: "See synth/vc5_kernels.js SpfKernel — the three numerators, the shared denominator and the four state pairs are written out there.",
    deviations: [
      "D-SPF-POLY: Rack polyphony (16 channels through four SIMD lanes) is absent; our audio wire is mono.",
      "D-SPF-CLAMP: the cutoff clamp is theirs, `[2, fs × 0.33]`, which is below Nyquist on purpose.",
      "D-NOCV: per V2.",
    ],
  },
};

export const VCV_XFXF35_SPEC = {
  type: "audio_vcv_xfxf35", module: "vcvXfxf35", title: "XFX F-35", family: "filter",
  icon: "mdi:filter-variant", readout: "frequency", w: 175,
  help: "Blamsoft's XFX F-35 — a 35-mode zero-delay-feedback filter with 4× windowed-sinc oversampling. ⚠ THIS PORT IS BEHAVIOUR-DERIVED: the plugin is CLOSED SOURCE (no `sourceUrl` in VCVRack/library manifests/Blamsoft-XFXF35.json; Blamsoft ships binaries), so what is ported is the TOPOLOGY THE VENDOR STATES — Sallen-Key, state-variable and four-stage ladder, all zero-delay-feedback, oversampled 4× — in the vendor's own mode order, with OUR coefficients. TWENTY-SIX OF THE THIRTY-FIVE MODES ARE HERE; the nine absent ones are each a different algorithm rather than another tap, and selecting one is a loud error that names it, not a silent substitution. See synth/vc5_kernels.js.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "frequency", type: "number", label: "freq" },
    { key: "resonance", type: "number", label: "reso" },
    { key: "drive", type: "number", label: "drive" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "frequency", label: "Cutoff", default: 1000, min: 20, max: 20000, step: 1, unit: " Hz", help: "The vendor's stated range, verbatim: 20 Hz to 20 kHz. In HERTZ rather than a dial, because this module's dial taper is not published and a real unit beats a guessed curve — the same call this block makes for Chronoblob2's Time." },
    { key: "resonance", label: "Resonance", default: 0, ...UNIT, help: "One dial across all three families: the ladder's feedback reaches k = 4 (four-pole self-oscillation), the state-variable's damping falls to Q = 25, the Sallen-Key's Q reaches 10. Mapped so the three feel the same under the same knob." },
    { key: "drive", label: "Drive", default: 0, ...UNIT, help: "1× to 10× into a saturator ahead of the filter, and the reason the oversampling is there — a nonlinearity at 4× aliases into the top octave far less. In `sk_lp12` the saturator sits in the RESONANCE path instead, so driving that mode compresses its own peak rather than clipping the output. That is the one structural difference between it and `sv_lp12`." },
    {
      key: "mode", label: "Mode", default: "sv_lp12", discrete: true,
      options: [
        "sk_lp12", "sk_hp6",
        "sv_lp12", "sv_lp24", "sv_bp6", "sv_bp12", "sv_hp12", "sv_hp24", "sv_peak12", "sv_peak24",
        "ladder_lp6", "ladder_lp12", "ladder_lp18", "ladder_lp24",
        "ladder_bp6", "ladder_bp12",
        "ladder_hp6", "ladder_hp12", "ladder_hp18", "ladder_hp24",
        "ladder_hp12_lp6", "ladder_hp18_lp6",
        "ladder_notch", "ladder_notch_lp6", "ladder_phase", "ladder_phase_lp6",
      ],
      help: "Twenty-six of the vendor's thirty-five, in their numbering (mode 1 is `sk_lp12`, mode 26 is `ladder_phase_lp6`). ABSENT, by their numbers: 27 Diode Lowpass 24 dB, 28-30 Dual Resonator 1/2/3, 31-32 Comb ±, 33 Frequency Modulation, 34 Ring Modulation, 35 Bitcrusher — each needs its own algorithm or a second audio input, so none is a tap on the two topologies here. The `ladder_*_lp6` variants add a one-pole rolloff on top, which is what tames a highpass or a notch enough to sit in a mix.",
    },
    { key: "oversample", label: "Oversampling", default: "4x", discrete: true, construct: true, options: ["1x", "4x"], help: "CONSTRUCT-TIME: it reallocates the oversampler's two 31-tap FIR state buffers and re-derives its kernel, so changing it rebuilds the module. The vendor's own figure is 4×, and it is the default. `1x` exists because the oversampler is eight filter evaluations and a 31-tap sinc per sample: on a CPU-bound deck the aliasing may be the better trade. Audible difference is confined to high drive at high cutoff." },
  ],
  derivation: {
    kind: "behaviour",
    source: "Blamsoft-XFXF35/Blamsoft-XFXF35 — CLOSED SOURCE, no sourceUrl in VCVRack/library manifests/Blamsoft-XFXF35.json. Documents: blamsoft.com/vcv-rack/xfx-f-35 (the numbered 35-mode list and the topology statement); library.vcvrack.com/Blamsoft-XFXF35/Blamsoft-XFXF35",
    block: "N/A — no code was read. The vendor's mode list and its statement of '4x windowed sinc oversampling', 'Zero Delay Feedback' and a '20 Hz to 20 kHz' cutoff range.",
    recurrence: "See synth/vc5_kernels.js Xfxf35Kernel — the TPT ladder, the TPT state-variable filter, the Sallen-Key and the oversampler are written out there.",
    deviations: [
      "D-XF-MODES: 26 of 35 shipped. The nine absent modes are LISTED in XFXF35_MODES with a `shipped: false` flag rather than dropped, so mode 28 cannot silently come to mean mode 31, and selecting one throws with its number and name.",
      "D-XF-COEF: the coefficients are OURS, from the standard TPT formulations, because the vendor's are unpublished. The topology and the order of every mode match the vendor's own names; the exact voicing does not.",
      "D-XF-OS: the oversampler is a 31-tap Blackman-windowed sinc at 4x — the vendor's stated method, not their kernel.",
      "D-XF-POLY: the v1 module gained polyphony on its frequency input; our wire is mono.",
      "D-NOCV: per V2.",
    ],
  },
};

// ── SOURCES ─────────────────────────────────────────────────────────────────

export const VCV_TERRORFORM_SPEC = {
  type: "audio_vcv_terrorform", module: "vcvTerrorform", title: "Terrorform", family: "source",
  icon: "mdi:chart-sankey", readout: "shape", w: 195,
  help: "Valley's TERRORFORM — a wavetable oscillator whose real instrument is its TWENTY-SEVEN PHASE SHAPERS. The table is read at a distorted phase, so a single sine frame already gives dozens of timbres: measured, `wrinkleX4` at depth 0.5 turns a pure sine into a fifth-harmonic-dominant spectrum with third and seventh sidebands, and `harmonics` glides continuously up the series. It also carries a slaved sub-oscillator, a Buchla-style lowpass gate and phase feedback (Skew). ⚠ THE 64 MB WAVETABLE ROM IS NOT SHIPPED AND CANNOT BE — eight analytic banks stand in its place, so the SCANNING and MORPHING are exact and the timbres inside a frame are not the original recordings. That and four other omissions are named in synth/vc5_kernels.js.",
  inputs: [
    { key: "v_oct", type: "number", label: "pitch" },
    { key: "fm", type: "number", label: "fm" },
    { key: "wave", type: "number", label: "wave" },
    { key: "shape_depth", type: "number", label: "shape" },
    { key: "skew", type: "number", label: "skew" },
    { key: "lpg_attack", type: "number", label: "attack" },
    { key: "lpg_decay", type: "number", label: "decay" },
    { key: "trigger", type: "trigger", label: "trig" },
    { key: "sync", type: "trigger", label: "sync" },
  ],
  outputs: [
    { key: "main", type: "audio", label: "main" },
    { key: "raw", type: "audio", label: "raw" },
    { key: "sub", type: "audio", label: "sub" },
    { key: "env", type: "audio", label: "env" },
    { key: "phasor", type: "audio", label: "phasor" },
    { key: "eoc", type: "audio", label: "eoc" },
  ],
  knobs: [
    { key: "octave", label: "Octave", default: 0, min: -3, max: 3, step: 1, unit: " oct", help: "Coarse tuning in whole OCTAVES, rounded to an integer as theirs is — the one pitch control here that is not in semitones, because that is what its own panel label says it is." },
    { key: "coarse", label: "Coarse", default: 0, min: -12, max: 12, step: 0.01, unit: " st", help: "±12 semitones, continuous. Their dial is ±1 in volts; V4's semitone convention makes that ±12." },
    { key: "fine", label: "Fine", default: 0, min: -0.5, max: 0.5, step: 0.001, unit: " st", help: "±half a semitone — their range exactly (their ±0.041666 volts IS half a semitone). This is the detune knob for stacking two of these." },
    {
      key: "bank", label: "Bank", default: "basic", discrete: true, construct: true,
      options: ["basic", "add_saw", "add_sqr", "fold_sine", "pwm", "bitcrush", "harmonic", "chebyshev"],
      help: "CONSTRUCT-TIME: 128 KB of wavetable is generated when the bank changes, so this rebuilds the module. ⚠ THESE ARE NOT THE ORIGINAL'S 64 BANKS. Terrorform links 64 binary blobs of 1 MB each — 64 MB, with no closed form to compress. These eight are analytic families with the same 16-frame morph structure: `basic` is sine→triangle→saw→square, `add_saw`/`add_sqr` grow their harmonic count (band-limited, so scanning up opens the spectrum without aliasing), `fold_sine` drives a sine into the saturator, `pwm` narrows a pulse, `bitcrush` quantises amplitude, `harmonic` is one partial per frame, and `chebyshev` is the waveshaper basis T1..T16. A patch that selected a ROM bank should be pointed at the nearest of these, and it will not be the same samples.",
    },
    { key: "wave", label: "Wave", default: 0, ...UNIT, help: "The scan position through the bank's sixteen frames. THIS IS WHAT MAKES IT A WAVETABLE OSCILLATOR: two frames are read at the same phase and crossfaded by the fractional part, so sweeping this glides rather than steps. The very top reads one frame twice — a flat spot, theirs." },
    {
      key: "shape", label: "Shape", default: "bend", discrete: true,
      options: [
        "bend", "tilt", "lean", "twist", "wrap", "sineWrap", "mirror", "harmonics",
        "warble", "reflect", "pulse", "step4", "step8", "step16", "varStep",
        "buzzX2", "buzzX4", "buzzX8", "wrinkleX2", "wrinkleX4", "wrinkleX8",
        "sineDownX2", "sineDownX4", "sineDownX8", "sineUpX2", "sineUpX4", "sineUpX8",
      ],
      help: "The phase distortion, IN PANEL ORDER (their `phasorShapeMap`, which is NOT the enum order — getting it wrong selects the wrong distortion for every ported patch). `bend`/`tilt`/`lean`/`twist` are segment slopes. `wrap`/`mirror`/`pulse` hard-sync the table to itself. `stepN`/`varStep` quantise the phase. `harmonics` glides up the harmonic series. `buzz`/`wrinkle`/`sineUp`/`sineDown` add a higher-rate copy of the phasor, which is where the sidebands come from. `warble` is the one that needs the Seed knob.",
    },
    { key: "shape_depth", label: "Shape depth", default: 0, ...UNIT, help: "At 0 every shaper is the exact identity, so the table is read straight and the oscillator is a plain wavetable. Everything interesting is above 0." },
    { key: "skew", label: "Skew", default: 0, ...UNIT, help: "PHASE FEEDBACK: the previous sample's output added to the read phase, scaled by 0.18. A self-modulating oscillator, so it is chaotic at the top — and it is a function of the audio stream, not of frame history, so it stays deterministic and exports correctly." },
    { key: "fm_level", label: "FM level", default: 0, ...UNIT, help: "Depth of the `fm` input, scaled by 0.2 as theirs is. THE FOUR FM INPUTS OF THE ORIGINAL (A1, A2, B1, B2, plus two VCA inputs) ARE ONE PORT HERE, because the C++ sums all of them into one value before using it — the A/B split was a mixer, not two paths." },
    { key: "true_fm", label: "True FM", default: "off", ...SWITCH, help: "Off, `fm` is PHASE modulation. On, it is added to the frequency at 1000 Hz per unit — through-zero, so the oscillator can run backwards. Switching this resets the phase, as theirs does." },
    { key: "sub_level", label: "Sub level", default: 0, ...UNIT, help: "How much sub-oscillator joins the main output. It is SLAVED to the main phasor, so it is always exactly an octave down and always in phase — and band-limited against the main oscillator's own step size, so it stays clean under FM." },
    { key: "sub_wave", label: "Sub wave", default: 0, ...UNIT, help: "One knob through four waves: sine, saw, square, then `glitch` — a flip-flop on the MAIN output's zero crossings, so its period depends on the wavetable frame and changes with the Wave knob. That is why it is called glitch." },
    { key: "lpg_mode", label: "LPG", default: "bypass", discrete: true, options: ["bypass", "vca", "filter", "both"], help: "The lowpass gate. `vca` is amplitude only. `filter` is a two-pole lowpass whose cutoff is the envelope CUBED — which closes far faster than the amplitude does, and is exactly what makes a Buchla-style gate sound plucked rather than gated. `both` is the real thing. A knob rather than their press-and-hold button, because a gesture is not property state." },
    { key: "lpg_attack", label: "LPG attack", default: 0, ...UNIT, help: "Rise time, through a sixth-power curve — so the fast end of the dial is far more sensitive than the slow end. Theirs." },
    { key: "lpg_decay", label: "LPG decay", default: 0.5, ...UNIT, help: "Fall time, same sixth-power curve." },
    { key: "lpg_long", label: "LPG long times", default: "off", ...SWITCH, help: "Extends both dials' range (their `longOffset` of 0.25 inside the curve), for pads rather than plucks." },
    { key: "lpg_velocity", label: "LPG velocity", default: "off", ...SWITCH, help: "On, the `trigger` input's LEVEL becomes the envelope's peak, so a velocity signal plays dynamics. Off, any trigger above zero is full scale." },
    { key: "lpg_trigger", label: "LPG one-shot", default: "off", ...SWITCH, help: "On, a rising edge fires the whole envelope regardless of gate length (one-shot). Off, the envelope sustains while the gate is high." },
    { key: "post_pm_shape", label: "Shape before PM", default: "off", ...SWITCH, help: "Which comes first. Off: modulate the phase, then shape it. On: shape, then modulate. Different sound, not a refinement — the shapers are nonlinear, so the order matters." },
    { key: "lfo_mode", label: "LFO mode", default: "off", ...SWITCH, help: "Divides the pitch by 100 and opens the output DC blocker, so the oscillator becomes a modulation source you can shape with the same 27 distortions." },
    { key: "zero_freq", label: "Zero frequency", default: "off", ...SWITCH, help: "Forces the frequency to exactly 0, so the phase only moves when something modulates it. The oscillator becomes a WAVESHAPER of whatever is patched to `fm`." },
    { key: "swap", label: "Sub after LPG", default: "off", ...SWITCH, help: "Whether the sub-oscillator joins before or after the lowpass gate. Before, the gate shapes the sub too; after, the sub stays constant under a plucked gate." },
    { ...SEED },
  ],
  derivation: {
    kind: "source",
    source: "ValleyAudio/ValleyRackFree, model Terrorform @ 86f02e431136a7f5c96a872b99b7115b7e133e05 — src/Terrorform/Terrorform.cpp, src/dsp/generators/QuadOsc.cpp, src/dsp/shaping/Shaper.cpp, src/dsp/filters/VecLPG.hpp, src/dsp/generators/TFormSubOsc.hpp, src/dsp/modulation/Vec{AREnvelope,Segment}.hpp",
    block: "Terrorform::process (the panel, and its `if (counter > 512)` clock divider), ScanningQuadOsc::tick (the morphing table read), Shaper::process + its 27 methods, Terrorform::phasorShapeMap (the DIAL order), VecLPG::process, TFormSubOsc::process",
    recurrence: "See synth/vc5_kernels.js SHAPERS, TerrorformKernel, LowpassGate, ArEnvelope and TFormSubOsc.",
    deviations: [
      "D-TF-BANK: the 64 MB wavetable ROM (64 blobs of 1048576 bytes) is not shipped. Eight analytic banks stand in. The oscillator, the scan and the morph are exact; the timbres inside a frame are not the original recordings. THIS IS THE LARGEST DEVIATION IN THIS BLOCK.",
      "D-TF-ENHANCER: VecEnhancer (296 lines, its own mode list), the Enhance Type and Depth controls and the ENHANCER_OUTPUT tap are NOT ported. P20 — the one selected patch using Terrorform — leaves Enhance Depth at 0, so nothing in the twenty patches needs it. It is the obvious next piece of work.",
      "D-TF-SYNC: one sync mode (HARD_SYNC, which is what P20 stores) of the sixteen the oscillator declares.",
      "D-TF-POLY: four SIMD groups, unison spread and the voice allocator are absent; our audio wire is mono. P20 stores numVoices 0 and spreadActive 0.",
      "D-TF-USERWAVE: the user wavetable editor and its file loader are out of scope for a document format.",
      "D-TF-VARSTEP: their `varStep` divides by zero at depth exactly 1.0 and returns NaN, which would poison every downstream filter permanently. Floored at one step — the limit of the sequence — and reported rather than reproduced.",
      "D-TF-2005: the sub-oscillator's sine carries their 2.005 fudge factor, so it is 0.25% sharp of a true octave. Kept: that beat is the sound.",
      "D-TF-LPGBUTTON: their LPG mode cycles on a press and bypasses on a 500 ms hold; a gesture is not property state, so it is a four-value knob.",
      "D-TF-WARBLERATE: `warble`'s two noise filters are hard-coded at 44100 in the original; ours run at the context rate so the wobble is not sample-rate dependent.",
      "D0: `Shaper`'s noise seeds from `std::time(NULL)`. Ours is the Seed knob.",
      "The four FM inputs and two FM VCA inputs collapse to one `fm` port, because the C++ sums them all before use.",
    ],
  },
};

// ── MODULATION ──────────────────────────────────────────────────────────────

export const VCV_REWIN_SPEC = {
  type: "audio_vcv_rewin", module: "vcvRewin", title: "rewin", family: "modulation",
  icon: "mdi:piano", readout: "scale", w: 165,
  help: "repelzen's REWIN — four V/oct quantisers sharing one twelve-note scale, with per-channel octave transposition. The scale is ONE NUMBER here: a twelve-bit mask, bit 0 = C, so 2773 is the major scale and an equation can sweep it. THEIR SIXTEEN SCENE SLOTS ARE GONE ON PURPOSE — in PowerRP a scene change is a keyframe on that mask, one scale per slide, tweenable, with no fixed bank size. Every pitch port is in SEMITONES FROM C4, so a quantised note lands in an oscillator's pitch input at the same scale instead of detuning it. Derivation in synth/vc5_kernels.js.",
  inputs: [
    { key: "in_1", type: "number", label: "in 1" },
    { key: "in_2", type: "number", label: "in 2" },
    { key: "in_3", type: "number", label: "in 3" },
    { key: "in_4", type: "number", label: "in 4" },
    { key: "transpose", type: "number", label: "oct" },
    { key: "semi", type: "number", label: "semi" },
  ],
  outputs: [
    { key: "out_1", type: "audio", label: "out 1" },
    { key: "out_2", type: "audio", label: "out 2" },
    { key: "out_3", type: "audio", label: "out 3" },
    { key: "out_4", type: "audio", label: "out 4" },
  ],
  knobs: [
    { key: "scale", label: "Scale", default: 2773, min: 0, max: 4095, step: 1, help: "The allowed notes as a TWELVE-BIT MASK, bit 0 = C: 2773 is major (C D E F G A B), 1453 is natural minor, 661 is pentatonic, 4095 is chromatic (no quantisation) and 0 passes the input through unquantised — the source's own empty-scale guard. A number rather than twelve buttons for the same reason AX-2's LFSR polynomial is a number: an equation can sweep it and a keyframe can change key mid-slide." },
    { key: "mode", label: "Direction", default: "down", discrete: true, options: ["down", "up", "nearest"], help: "Which way an out-of-scale note moves. THE ORDER IS THEIR ENUM's, not their menu's, so a stored value still selects the same mode — and `down` really is their default. In an evenly-spaced scale like major, `nearest` ties go DOWN, so it and `down` agree; in pentatonic they differ." },
    { key: "octave_1", label: "Octave 1", default: 0, min: -4, max: 4, step: 1, unit: " oct", help: "Channel 1's octave, added to the shared `transpose` input and clamped together to ±4." },
    { key: "octave_2", label: "Octave 2", default: 0, min: -4, max: 4, step: 1, unit: " oct", help: "Channel 2's octave." },
    { key: "octave_3", label: "Octave 3", default: 0, min: -4, max: 4, step: 1, unit: " oct", help: "Channel 3's octave." },
    { key: "octave_4", label: "Octave 4", default: 0, min: -4, max: 4, step: 1, unit: " oct", help: "Channel 4's octave — four channels off one scale is how you voice a chord from one sequencer." },
  ],
  derivation: {
    kind: "source",
    source: "wiqid/repelzen src/erwin.cpp (file `erwin`, MODEL SLUG `rewin`) + src/repelzen-math.hpp @ 78b1765eb9ccb9e4e2a1967ee02f4126b1846806. THE REPO WAS NOT PRE-CLONED and the registry lists it as unidentified; found and cloned for this port.",
    block: "Erwin::process, plus modN and ceilN from repelzen-math.hpp",
    recurrence: "See synth/vc5_kernels.js RewinKernel — the two scale searches, the empty-scale guard and the transposition are written out there.",
    deviations: [
      "D-RW-SCENES: their sixteen scale scenes, the scene knob, the scene CV input and the JSON import/export are not ported. A scene is a KEYFRAME on the scale mask here, which is strictly more expressive than sixteen slots.",
      "D-RW-BUTTONS: the twelve note buttons and lights are the UI of the mask; the mask is the state.",
      "V4: every pitch port is in SEMITONES from C4, both directions, per the lead's R7-UNITS ruling — so a quantised note lands in an oscillator's pitch input at the same scale.",
      "`trunc` and `ceilN` both round toward or away from ZERO, so the quantiser is not translation-invariant across 0 V. Theirs, reproduced.",
      "The `semi` port's 1.2-per-volt factor is theirs (twelve semitones over ten volts), so twelve semitones IN transposes ONE semitone. Not a clean control, and not made into one.",
    ],
  },
};

export const VCV_REBURST_SPEC = {
  type: "audio_vcv_reburst", module: "vcvReburst", title: "reburst", family: "modulation",
  icon: "mdi:dots-horizontal", readout: "rep",
  help: "repelzen's REBURST — one trigger becomes a burst of up to eight pulses whose spacing COLLAPSES geometrically: at acceleration 2 the last gap is 1/256 of the first, measured here at 0.5, 0.25, 0.125 s. That collapse is the module; it is not a ritardando. It also emits a CV shape per burst (eight of them, four random) and an end-of-cycle pulse, and it can lock to a clock. Its randomness is SEEDED here — see the Seed knob. Derivation in synth/vc5_kernels.js.",
  inputs: [
    { key: "gate", type: "trigger", label: "gate" },
    { key: "clock", type: "trigger", label: "clock" },
    { key: "rep", type: "number", label: "rep" },
    { key: "time", type: "number", label: "time" },
  ],
  outputs: [
    { key: "gate_out", type: "audio", label: "gate" },
    { key: "eoc", type: "audio", label: "eoc" },
    { key: "cv", type: "audio", label: "cv" },
  ],
  knobs: [
    { key: "time", label: "Time", default: 0.508, min: 0, max: 1, step: 0.001, help: "The first gap, through their exponential dial `(e^t − 1)/(e − 1)` — so the bottom of the dial is fine and the top is a full second. WHEN A CLOCK IS PATCHED it becomes a multiplier instead, `2^int(dial·8 − 4)`, and the exponential mapping is discarded — read the RAW dial, which is a source quirk named in the kernel." },
    { key: "rep", label: "Repetitions", default: 4, min: 0, max: 8, step: 1, help: "How many pulses the burst fires. 0 fires only the initial gate." },
    { key: "accel", label: "Acceleration", default: 1, min: 1, max: 2, step: 0.01, unit: "×", help: "Each gap is the previous one divided by this, COMPOUNDING — so 2 over eight repetitions collapses the last gap to 1/256 of the first. 1 is even spacing." },
    { key: "jitter", label: "Jitter", default: 0, ...UNIT, help: "Randomises each gap by up to this fraction of itself, plus or minus. Two random draws per pulse, in their order, from the seeded generator." },
    { key: "cv_mode", label: "CV shape", default: "up", discrete: true, options: ["up", "down", "alt_widen", "alt_ramp", "random_pos", "random_neg", "random_walk", "random"], help: "The stepped CV each pulse emits, spanning 5 V across the burst. Their enum order, so a stored integer still selects one; `alt_widen` and `alt_ramp` are their unnamed CV_MODE3 and CV_MODE4 — the first walks outward in widening steps, the second alternates sign on a straight ramp. The four random modes draw from the seeded generator." },
    { key: "gate_mode", label: "Gate length", default: "gate", discrete: true, options: ["gate", "trigger"], help: "`gate` makes each pulse half its own gap long, so the burst's gates shorten as it accelerates. `trigger` makes every pulse a fixed 10 ms." },
    { ...SEED },
  ],
  derivation: {
    kind: "source",
    source: "wiqid/repelzen src/burst.cpp (file `burst`, MODEL SLUG `reburst`) @ 78b1765eb9ccb9e4e2a1967ee02f4126b1846806. Cloned for this port; the registry lists the repo as unidentified.",
    block: "Burst::process",
    recurrence: "See synth/vc5_kernels.js ReburstKernel — the geometric acceleration, the jitter draws and the eight CV shapes are written out there.",
    deviations: [
      "D0: `rack::random::uniform()` is called three times per pulse (jitter magnitude, jitter sign, then the CV) and all three come from the seeded generator here, IN THAT ORDER. The distribution matches; the specific numbers cannot.",
      "D-RB-BUTTON: the manual-burst button is momentary and so not property state; the `gate` input covers it.",
      "D-RB-PULSEWIDTH: their 10 ms EOC pulse and trigger-mode gate are hard-coded; kept.",
      "The sync multiplier reads the RAW time dial rather than the exponential one, and truncates toward zero — so the step boundaries are asymmetric about the dial's centre. Theirs, reproduced.",
      "D-NOCV: per V2.",
    ],
  },
};

/**
 * EVERY VC-5 SPEC — effects, then filters, then sources, then modulation, the
 * same ordering rule core/audio_specs.AUDIO_SPECS follows so the palette reads as
 * one library rather than as four lists that happen to be adjacent.
 *
 * THE BARREL LINE THIS NEEDS (the LEAD applies it; this block does not touch the
 * five aggregation seams): `core/audio_blocks.js` must import this array and
 * spread it into `PORT_BLOCK_SPECS`.
 */
export const BLOCK_SPECS = [
  VCV_PLATEAU_SPEC, VCV_CHRONOBLOB2_SPEC, VCV_JUSTAPHASER_SPEC,
  VCV_FELINE_SPEC, VCV_SPF_SPEC, VCV_XFXF35_SPEC,
  VCV_TERRORFORM_SPEC,
  VCV_REWIN_SPEC, VCV_REBURST_SPEC,
];
