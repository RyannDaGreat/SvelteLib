/**
 * THE MECHANISM — dump manifest verbatim law (user request 3): one PPT
 * mouse-click boundary = one new PowerRP delta (slide). A PPT slide with N
 * click steps becomes 1+N PowerRP slides; entrance-later shapes start
 * `active:false` on the base slide; each click step's slide flips the
 * step's shapes' `active` with the mapped `active~interp` mode and a
 * per-item `delay` leaf (seconds, from the effect's `delayMs`); the step
 * slide's OWN transition is `{type:"tween", seconds: max(delay_i+dur_i),
 * curve:"smooth"}` — the tween must be at least as long as the slowest
 * effect plus its own stagger, or a later effect would be cut off.
 *
 * ENTRANCE VS EXIT: `presetClass` distinguishes them ("entr" enters —
 * active:false -> true; "exit" leaves — active:true -> false). "emph"
 * (emphasis, e.g. deck 1's afterEffect on shape 3) has no PowerRP visual
 * analogue today (no flash/pulse effect) — reported as a gap, its DELAY
 * still applied to nothing observable (translate.js drops it from the
 * delta but keeps the report).
 */

/** PPT entrance/exit animation preset IDs (research_04's empirically-sourced
 * table, cross-checked against the fixture's own presetId=10 "Fade" click
 * steps) -> PowerRP's `active~interp` mode. Presets with no row here use
 * PowerRP's DEFAULT mode for a boolean (absent `~interp`, which is already a
 * step-like discrete switch — core/interp_modes.defaultModeFor — so "Appear"
 * needs no explicit mode at all). */
const ENTRANCE_EXIT_INTERP = {
  1: null, // Appear -> PowerRP's own default (absent ~interp) is already a discrete switch
  10: "fade", // Fade
  59: "grow", // GrowShrink (closest PowerRP analogue to a size-based entrance)
};

/**
 * Pure function. One PPT entrance/exit preset id -> the `active~interp`
 * mode to write, or `null` for "leave it at PowerRP's own default" (Appear,
 * and anything unmapped — see the refusal this produces for the unmapped
 * case).
 *
 * @param {number|null} presetId
 * @returns {{mode: string|null, refusal: string|null}}
 *
 * @example interpModeForPreset(10) // {mode: "fade", refusal: null}
 * @example interpModeForPreset(1) // {mode: null, refusal: null}
 * @example interpModeForPreset(999) // {mode: null, refusal: "entrance/exit preset id 999 has no translator mapping — using PowerRP's default visibility switch (an instant cut, closest to Appear)"}
 */
export function interpModeForPreset(presetId) {
  if (presetId === null || presetId === undefined) return { mode: null, refusal: null };
  if (presetId in ENTRANCE_EXIT_INTERP) return { mode: ENTRANCE_EXIT_INTERP[presetId], refusal: null };
  return { mode: null, refusal: `entrance/exit preset id ${presetId} has no translator mapping — using PowerRP's default visibility switch (an instant cut, closest to Appear)` };
}

/**
 * Pure function. Every DISTINCT DeckIR shapeId a click step's effects touch,
 * keyed to WHETHER the step's mainseq processing found an entrance
 * (presetClass "entr"), exit ("exit"), or something else (emphasis/media)
 * for it — one step may touch several shapes ("withEffect" simultaneity).
 *
 * @param {{effects: object[]}} clickStep - DeckIR clickSteps[i]
 * @returns {{shapeId:number, kind:"entr"|"exit"|"other", presetId:number|null, delayMs:number, durMs:number|null}[]}
 *
 * @example
 * >>> stepEffects({effects: [{shapeId:2, presetClass:"entr", presetId:10, delayMs:0, durMs:500}]})
 * [{"shapeId": 2, "kind": "entr", "presetId": 10, "delayMs": 0, "durMs": 500}]
 */
export function stepEffects(clickStep) {
  return clickStep.effects
    .filter((e) => e.shapeId !== null)
    .map((e) => ({
      shapeId: e.shapeId,
      kind: e.presetClass === "entr" ? "entr" : e.presetClass === "exit" ? "exit" : "other",
      presetId: e.presetId,
      delayMs: e.delayMs ?? 0,
      durMs: e.durMs,
    }));
}

/**
 * Pure function. THE step slide's transition seconds: the max over the
 * step's effects of (delay + duration), per the design doc — a step whose
 * slowest effect finishes at 1.25s needs a 1.25s transition or the tween
 * would cut it off mid-flight. Effects with no duration (durMs null —
 * DeckIR's own "indefinite"/unset marker) are treated as an
 * INSTANTANEOUS switch at their delay (0-length effect window), matching
 * `core/document.itemDelayAlpha`'s own d>=T "step at the very end" law for
 * a zero-length remaining window.
 *
 * @param {{delayMs:number, durMs:number|null}[]} effects
 * @returns {number}
 *
 * @example stepTransitionSeconds([{delayMs:0, durMs:500}, {delayMs:750, durMs:300}]) // 1.05
 * @example stepTransitionSeconds([]) // 0
 */
export function stepTransitionSeconds(effects) {
  if (effects.length === 0) return 0;
  return Math.max(...effects.map((e) => (e.delayMs + (e.durMs ?? 0)) / 1000));
}

/**
 * Pure function. Which of a slide's shapeIds should start `active:false` on
 * the BASE (step-0) slide — every shape targeted by an ENTRANCE effect
 * anywhere in the slide's click steps (it is not yet on stage until its own
 * step arrives). A shape with an EXIT effect starts visible (it is on stage
 * from the base slide, per its base-state fold, until its exit step hides
 * it) — exit shapes are NOT in this set.
 *
 * @param {{trigger:string, effects:object[]}[]} clickSteps
 * @returns {Set<number>}
 *
 * @example entranceLaterShapeIds([{trigger:"click", effects:[{shapeId:2, presetClass:"entr", presetId:10, delayMs:0, durMs:500}]}]) // Set(1) {2}
 */
export function entranceLaterShapeIds(clickSteps) {
  const out = new Set();
  for (const step of clickSteps) for (const e of stepEffects(step)) if (e.kind === "entr") out.add(e.shapeId);
  return out;
}
