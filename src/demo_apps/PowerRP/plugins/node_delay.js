/**
 * DELAY — the LATENT node: it registers a continuation and returns immediately,
 * and the continuation runs some slides later.
 *
 * ── WHY IT WAITS IN SLIDES AND NOT IN SECONDS ───────────────────────────────
 * Blueprint's `Delay` waits on a wall clock, and the manifest refuses that outright:
 * a wall-clock delay is EPHEMERAL by this project's taxonomy, so it would break
 * Δt = 0 reproducibility, frame-range sharding and export reproducibility at once.
 * R7-8's design says it *"becomes `DelayAlpha(Δalpha)`"*.
 *
 * IT IS SLIDES RATHER THAN ALPHA, AND THAT IS A CORRECTION WORTH STATING, because
 * `DelayAlpha` sounds cheaper than it is. A continuation at j + 0.5 IS enumerable —
 * the schedule stays finite. What it destroys is the property that makes the whole
 * subsystem affordable: the exec overlay currently depends on the SLIDE INDEX ONLY,
 * so one replay serves every frame of a tween (core/exec_flow.js: THE FIRING SCHEDULE
 * IS THE SLIDE GRID). A firing position inside a transition makes the overlay a
 * function of alpha, and then every frame of every tween needs its own replay. Slides
 * are the axis the document itself is discrete on; alpha is the axis it interpolates
 * on, and events belong on the first.
 *
 * ── THE MECHANISM IS BLUEPRINT'S, AND IT IS THE STATELESS ONE ───────────────
 * *"Latency is expressed as a node that owns its own resumption, not as a suspended
 * graph"* (§B3). `execLatent` returns a wait; core/exec_flow.js pushes
 * `{atSlide, item, port}` onto the boundary walk's pending queue and the boundary
 * that far ahead starts a chain from it. Nothing is suspended, nothing is carried
 * between frames — the queue is rebuilt from scratch by every replay, which is why
 * a delayed effect is as reproducible as an immediate one.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";

/** The shortest wait that MEANS anything: firing on the next boundary. A wait of 0
 *  would be an immediate forward, which is what wiring the chain directly already
 *  does — so 0 is not an option, it is a node you should not have inserted. */
const MIN_SLIDES = 1;

export const nodeDelayPlugin = execNodePlugin({
  type: "node_delay",
  title: "Delay",
  icon: "mdi:timer-sand",
  ports: {
    inputs: [{ key: "run", type: "exec", label: "Run" }],
    outputs: [{ key: "then", type: "exec", label: "Then" }],
  },
  own: { slides: 1 },
  rows: [
    { key: "slides", label: "Wait slides", kind: "number", category: EXEC_NODE_CAT, help: "How many slides later the rest of the chain runs. 1 means the next slide. It waits in SLIDES rather than seconds on purpose: a deck can be presented at any pace, and a wall-clock wait would render a different picture every time the video was exported." },
  ],
  readout: (s) => {
    const n = Math.max(MIN_SLIDES, Math.round(Number(s?.slides ?? MIN_SLIDES)) || MIN_SLIDES);
    return n === 1 ? "next slide" : `+${n} slides`;
  },
  /**
   * Pure function. How many slide boundaries to wait before the continuation fires.
   *
   * Clamped at MIN_SLIDES, not refused: a document holding 0 or a blank is a
   * half-finished edit, and the honest reading of "wait no slides" is the shortest
   * wait this node can express, which is also the one the readout shows.
   *
   * @param {object} ctx - core/exec_flow.js's run context
   * @returns {number} slides to wait, at least 1
   *
   * @example nodeDelayPlugin.execLatent({self: {slides: 3}}) // 3
   * @example nodeDelayPlugin.execLatent({self: {slides: 0}}) // 1
   * @example nodeDelayPlugin.execLatent({self: {}}) // 1
   */
  execLatent(ctx) {
    return Math.max(MIN_SLIDES, Math.round(Number(ctx.self?.slides ?? MIN_SLIDES)) || MIN_SLIDES);
  },
});
