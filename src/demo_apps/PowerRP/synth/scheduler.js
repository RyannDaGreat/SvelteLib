/**
 * THE TWO-CLOCK LOOKAHEAD SCHEDULER — sample-accurate timing for the clock and
 * the 16-step sequencer.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * The obvious way to build a sequencer is a setInterval that plays a note each
 * time it fires. It sounds terrible. setTimeout/setInterval are best-effort:
 * they jitter by tens of milliseconds under normal load and stop entirely
 * during a garbage collection, a layout, or a heavy canvas repaint — all of
 * which PowerRP does constantly while presenting. Timing error above ~2 ms is
 * audible on a percussive sound, so notes land visibly late and unevenly.
 *
 * ── THE SOLUTION (Chris Wilson, "A Tale of Two Clocks"; unanimous across the
 * research's [04] and [09]) ─────────────────────────────────────────────────
 * Separate the two roles that the naive design conflates:
 *
 *   CLOCK 1 — a JS timer (every SCHEDULER_TICK_MS ≈ 25 ms). Jittery and
 *             interruptible, and that is FINE, because it never plays anything.
 *             Its only job is to wake up and ask "what falls due soon?".
 *   CLOCK 2 — AudioContext.currentTime. Hardware-backed, sample-accurate, and
 *             completely immune to main-thread stalls. Every event is scheduled
 *             AT an explicit time on this clock, in the near future.
 *
 * Each tick schedules everything due within the next SCHEDULER_LOOKAHEAD_SECONDS
 * (≈100 ms). Because the window is 4x longer than the tick interval, a
 * main-thread stall of up to ~75 ms passes with every note already queued on the
 * audio clock and therefore completely inaudible.
 *
 * ── WHY THE MATH LIVES IN dsp.js ─────────────────────────────────────────────
 * `stepsInWindow` is a pure function of four numbers, so the timing logic is
 * proven by bare-node tests and this file is only the timer that drives it. The
 * edge-trigger rule (research [09]: track the cursor and never re-emit a passed
 * step) lives there too, which is what makes double-firing structurally
 * impossible rather than something the callback has to remember not to do.
 *
 * DOM-free apart from setInterval/clearInterval, and it never imports PowerRP.
 */

import { SCHEDULER_TICK_MS, SCHEDULER_LOOKAHEAD_SECONDS, stepDuration, stepsInWindow } from "./dsp.js";

/**
 * Create a lookahead scheduler bound to an AudioContext.
 *
 * COMMAND (owns a timer; mutates its own transport state).
 *
 * The scheduler knows nothing about what an event MEANS — it emits
 * (stepIndex, time) pairs and the engine decides what to play. That keeps the
 * sequencer, the clock module and any future piano roll on one implementation.
 *
 * Args:
 *     audioContext (AudioContext): Supplies clock 2 via .currentTime
 *
 * Returns:
 *     object: The scheduler handle (see methods below)
 *
 * Examples:
 *     >>> // const scheduler = createScheduler(audioContext)
 *     >>> // scheduler.setTempo(96, 4)          // 96 BPM, sixteenth notes
 *     >>> // scheduler.onStep((index, time) => engine.trigger("bell", "gate", time))
 *     >>> // scheduler.start()
 */
export function createScheduler(audioContext) {
  let bpm = DEFAULT_BPM;
  let stepsPerBeat = DEFAULT_STEPS_PER_BEAT;
  let stepCount = DEFAULT_STEP_COUNT;

  let timerId = null;
  let cursor = 0; // Time up to which steps are already scheduled (clock 2).
  let stepIndex = 0; // Which step of the pattern comes next.
  const listeners = new Set();

  /** Query. Seconds per step at the current tempo. */
  function secondsPerStep() {
    return stepDuration(bpm, stepsPerBeat);
  }

  /**
   * Command. One tick of clock 1: schedule every step falling inside the
   * lookahead window, then sleep until the next tick.
   */
  function tick() {
    const { times, cursor: nextCursor } = stepsInWindow(
      audioContext.currentTime,
      cursor,
      secondsPerStep(),
      SCHEDULER_LOOKAHEAD_SECONDS,
    );
    cursor = nextCursor;

    for (const time of times) {
      const index = stepIndex % stepCount;
      stepIndex++;
      for (const listener of listeners) listener(index, time);
    }
  }

  return {
    /**
     * Command. Start the transport. Idempotent — starting a running scheduler
     * does nothing rather than installing a second timer (which would double
     * every event, a bug that is silent until you notice the tempo is wrong).
     */
    start() {
      if (timerId !== null) return;
      // Begin scheduling slightly ahead of now, so the first step is placed in
      // the future rather than in the past (a past time plays IMMEDIATELY,
      // which makes the first note of every start arrive early).
      cursor = audioContext.currentTime + START_OFFSET_SECONDS;
      timerId = setInterval(tick, SCHEDULER_TICK_MS);
      tick(); // Schedule the first window now rather than 25 ms from now.
    },

    /** Command. Stop the transport. Already-scheduled events inside the
     * lookahead window still sound — they are on the audio clock and cannot be
     * unscheduled from here; that is the tradeoff the lookahead buys. */
    stop() {
      if (timerId === null) return;
      clearInterval(timerId);
      timerId = null;
    },

    /** Command. Stop and rewind the pattern to step 0. */
    reset() {
      this.stop();
      stepIndex = 0;
      cursor = 0;
    },

    /**
     * Command. Set tempo and resolution. Takes effect at the next tick, so a
     * tempo change never retroactively moves already-scheduled notes.
     */
    setTempo(nextBpm, nextStepsPerBeat = stepsPerBeat) {
      bpm = nextBpm;
      stepsPerBeat = nextStepsPerBeat;
      // Validate immediately, so a bad tempo throws at the call site instead of
      // inside a timer callback where nothing can catch it.
      stepDuration(bpm, stepsPerBeat);
    },

    /** Command. Set the pattern length (the sequencer's step count). */
    setStepCount(count) {
      stepCount = Math.max(1, Math.floor(count));
    },

    /**
     * Command. Subscribe to step events. The callback receives
     * (stepIndex, audioTime) where audioTime is on clock 2 — pass it straight
     * to any AudioParam scheduling call.
     *
     * Returns: an unsubscribe function.
     */
    onStep(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Query. Is the transport running? */
    isRunning() {
      return timerId !== null;
    },

    /** Query. Current tempo settings and derived step duration. */
    transport() {
      return { bpm, stepsPerBeat, stepCount, secondsPerStep: secondsPerStep() };
    },
  };
}

const DEFAULT_BPM = 90;
const DEFAULT_STEPS_PER_BEAT = 4;
const DEFAULT_STEP_COUNT = 16;

/** How far ahead of "now" the first step is placed on start. Must be > 0 so the
 * first event is in the future; small enough that start feels immediate. */
const START_OFFSET_SECONDS = 0.05;
