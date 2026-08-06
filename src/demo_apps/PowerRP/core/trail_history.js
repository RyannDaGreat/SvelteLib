/**
 * THE TRAIL HISTORY — MANY steps of one point, built on the ONE step
 * core/simulation_history.js keeps. It is the store behind the TRAIL widget
 * (manifest R7-15, user: *"the trail widget, which can like keep a trail for a
 * certain amount of time for n seconds, so that it can kind of draw a streamer"*).
 *
 * ── WHICH KIND OF STATE A TRAIL IS, AND WHY IT DECIDES THE IMPLEMENTATION ─────
 * A trail is SIMULATED state, the fourth kind (PowerRP CLAUDE.md; manifest R7-9).
 * It is NOT recordable: recordable state is a function of ELAPSED TIME ALONE, so
 * `Δt = 0 ⟹ unchanged`, and a value at `t` that depends on its own value at
 * `t − dt` fails that by construction. It is not property state either — its value
 * is not reproducible under a shuffle of time.
 *
 * THEREFORE IT KEEPS NO PRIVATE BUFFER. Every sample lives in
 * core/simulation_history.js's OWN table, through recordSimulationValue /
 * simulationValue, and this module holds NO module-level state whatsoever. That is
 * not tidiness — a second accumulator would be a second history mechanism (the
 * Tower of Babel this project keeps paying for) with a second reset rule, and the
 * four properties a trail needs are exactly the four that table already provides:
 *
 *   RESET      resetSimulation() drops the whole table, so a trail is cleared by
 *              document load, jump-to-start, presentation start, render-job start
 *              and by the clock moving BACKWARDS — with no reset rule of its own to
 *              get wrong. (User requirement: a reset must clear the trail.)
 *   FREEZE     withSimulationFrozen() makes recordSimulationValue a no-op, so a
 *              thumbnail or the minimap of ANOTHER slide renders the current trail
 *              and cannot write into the presenter's timeline.
 *   THE ROLL   `prev` advances exactly ONCE per clock instant however many times
 *              the state is evaluated, which is what makes ~28 evaluations of one
 *              frame produce ONE sample.
 *   dt         the trail's clock is an ordinary simulated property (`= @ + dt`), so
 *              it honours the camera's max-timestep clamp and an export's DICTATED
 *              `1/fps` for free, and `documentIsSimulated` (core/document.js) sees
 *              a trail-bearing document as simulated — which is what makes
 *              stridedShardRefusal refuse to strided-shard it.
 *
 * ── Δt = 0 ⟹ BYTE-IDENTICAL, AND HOW IT IS STRUCTURAL HERE ───────────────────
 * advanceTrailHistory writes NOTHING unless the trail's clock has advanced since
 * the previous ROLL — `hasSimulationValue(clock)` is false until the first roll,
 * and after it the test is `age > prevAge`. In every still regime (editor,
 * thumbnails, minimap, PNG export, cli/render.js) the particle clock is PAUSED, so
 * no roll ever happens, so no sample is ever taken and a re-render is identical by
 * construction rather than by the arithmetic coming out the same.
 *
 * That gate also removes the one way this could have produced a FALSE scoping
 * report: dragging a trail in the paused editor changes `x` at an unmoved clock,
 * and a design that re-seeded on every pass would write two different values to one
 * key at one tick — which recordSimulationValue correctly reports as two consumers
 * advancing from different states. Everything written here is derived from `prev`
 * plus the settled state, so repeating a pass at one tick recomputes the IDENTICAL
 * numbers and the detector stays a real detector.
 *
 * ── THE COST: A TRAIL GIVES UP SEEKABILITY ───────────────────────────────────
 * Frame N genuinely depends on frames 0..N-1, so a trail-bearing deck cannot be
 * sharded by STRIDED frame range. That is not a new refusal to write: the trail's
 * clock is a `@`/`dt` equation in ordinary document state, so core/document.js
 * documentIsSimulated already answers true and stridedShardRefusal already refuses.
 * Pinned by tests/trail_test.js.
 *
 * ── THE RING: BOUNDED MEMORY, AND THE DECIMATION RULE ────────────────────────
 * A trail at 144 fps for 60 s would be 8640 points. The store is therefore a fixed
 * ring of TRAIL_SAMPLE_CAPACITY cells per trail, and the sample rate follows the
 * WINDOW rather than the frame rate:
 *
 *   SPACING    one sample every `seconds / TRAIL_SAMPLE_CAPACITY` seconds. A frame
 *              that arrives sooner than that writes nothing, so the point count is
 *              a function of the AUTHORED window and never of the display — 30 fps
 *              and 144 fps draw the same streamer, which is the same framerate
 *              independence `dt` buys the integrators.
 *   EVICTION   two rules, and they agree in the steady state. The ring overwrites
 *              its oldest cell (that is what makes the memory bound structural),
 *              and a read additionally drops any sample older than `seconds` — the
 *              second rule is what makes SHORTENING the window take effect on the
 *              next frame instead of after a full lap.
 *   THE TIP    the newest point of a drawn trail is the LIVE position, appended at
 *              read time and never stored, so the streamer's tip sits exactly on
 *              its anchor at every frame instead of lagging by up to one spacing.
 *              IT ALSO CLOSES THE DOUBLE BUFFER'S ONE-STEP LAG: a sample recorded
 *              this step lands in `cur` and is not readable until the next ROLL
 *              moves it to `prev` (that is the invariance the two tables buy), so
 *              the STORED history a frame can see always stops one step short. The
 *              live tip is exactly that missing step, which is why the drawn ribbon
 *              has no hole at its head and why a trail's point count is one less
 *              than the number of steps it has run.
 *
 * ── WHERE IT IS DRIVEN FROM, AND WHY THAT SEAM ───────────────────────────────
 * web/cameraFrame.js evaluationAt — "THE ONE seam that threads it for every pixel
 * consumer" (PowerRP CLAUDE.md, of the project script; the same is true here). It
 * covers the presenter, BOTH video exporters (web/transitionRender.js's letterbox
 * renderer evaluates through it, and that pass is the export's single ADVANCING
 * consumer — web/gpuService.js's docblock names the ordering), the PNG/thumbnail
 * path (frozen there, correctly) and the CLI hook.
 *
 * IT DOES NOT COVER THE EDITOR CANVAS, which evaluates through app.state(), AND
 * THAT IS CORRECT: presented time is frozen in the editor, so a simulated widget
 * shows its initial condition and does not move (manifest R7-9's ruling). A trail
 * in the editor is one dot on its anchor — the same way the sparkler does not
 * animate there. Preview by presenting.
 *
 * DOM-free, and imports only core/simulation_history.js + core/report.js.
 */

import { hasSimulationValue, simulationValue, recordSimulationValue } from "./simulation_history.js";
import { reportOnce } from "./report.js";

/**
 * The evaluated-state key a sampled widget's points are injected under. Injected
 * onto the EVALUATED item and NEVER stored, exactly as core/content_size.js injects
 * `content` — so emit() reads its history as an ARGUMENT and stays pure, which is
 * the rule render_gpu/ports.js states for every input emit() may not fetch itself.
 *
 * @example TRAIL_POINTS_KEY // "trail_points"
 */
export const TRAIL_POINTS_KEY = "trail_points";

/**
 * THE PROPERTY NAME of a sampled widget's own simulated clock, in seconds. One
 * name, because both halves must agree: the widget declares it as an ordinary
 * property defaulting to the equation `= @ + dt`, and this module reads BOTH its
 * settled value and its previous-step value (slot key `items.<id>.age`) from it.
 *
 * @example TRAIL_CLOCK_KEY // "age"
 */
export const TRAIL_CLOCK_KEY = "age";

/**
 * How many samples ONE trail stores. The memory bound is structural: a trail costs
 * exactly 3·capacity + 3 entries in the simulation table no matter how long it runs
 * or how fast the display is, where an unbounded recorder at 144 fps would cost
 * 8640 points for a 60 s window.
 *
 * 192 is chosen against the two things it trades off, both measured in units the
 * reader can check: the SMOOTHNESS of the drawn ribbon (192 samples across the
 * default 3 s window is one every 15.6 ms, i.e. 64 Hz — finer than a 60 Hz display
 * can show) and the PER-ROLL COST (core/simulation_history.js copies the whole
 * table at each roll, so three trails add ~1.7k entries to that copy).
 *
 * @example TRAIL_SAMPLE_CAPACITY // 192
 */
export const TRAIL_SAMPLE_CAPACITY = 192;

/** The slot-key namespace this module owns inside the simulation table. It is a
 *  HISTORY key, never a document path — no widget stores a property here, so it
 *  cannot collide with a slot the equation engine records. */
const TRAIL_HISTORY_NS = "trail_history";

/**
 * Pure function. Seconds between two stored samples of a trail whose window is
 * `seconds` — the DECIMATION rule, so the sample count follows the authored window
 * and never the display's frame rate.
 *
 * A non-positive or non-finite window has no spacing to state and is refused
 * loudly, rather than dividing and returning a plausible 0 that would sample every
 * frame forever.
 *
 * @param {number} seconds - the trail's window, in seconds (> 0)
 * @param {number} [capacity] - ring cells (defaults to TRAIL_SAMPLE_CAPACITY)
 * @returns {number} seconds between stored samples
 *
 * @example trailSpacingSeconds(3) // 0.015625 (192 samples across 3 s = 64 Hz)
 * @example trailSpacingSeconds(60) // 0.3125 (a minute-long trail samples every third of a second)
 * @example trailSpacingSeconds(1.92, 192) // 0.01
 */
export function trailSpacingSeconds(seconds, capacity = TRAIL_SAMPLE_CAPACITY) {
  if (!(seconds > 0) || !Number.isFinite(seconds))
    throw new Error(`trailSpacingSeconds: a trail window must be a positive number of seconds, got ${JSON.stringify(seconds)}`);
  return seconds / capacity;
}

/** Query. A recorded number, or null when this key has no PREVIOUS-step value.
 *  hasSimulationValue is asked first because undefined is a legal recorded value
 *  and therefore not a usable sentinel (core/simulation_history.js says so). */
function recorded(key) {
  return hasSimulationValue(key) ? simulationValue(key) : null;
}

/** Pure function. The history slot key for one ring cell's field. */
function cellKey(itemId, index, field) {
  return `items.${itemId}.${TRAIL_HISTORY_NS}.${index}.${field}`;
}

/** Pure function. The history slot key for one of a trail's ring scalars. */
function ringKey(itemId, field) {
  return `items.${itemId}.${TRAIL_HISTORY_NS}.${field}`;
}

/** Pure function. The slot key the EQUATION ENGINE records a trail's clock under —
 *  the same `items.<id>.<prop>` shape core/expressions.js prevTarget builds, which
 *  is why reading it here needs no cooperation from the engine. */
function clockKey(itemId) {
  return `items.${itemId}.${TRAIL_CLOCK_KEY}`;
}

/**
 * Command (writes the simulation table; writes NOTHING when the clock has not
 * advanced, and nothing at all inside withSimulationFrozen). Takes at most ONE new
 * sample of `itemId`'s tracked point.
 *
 * THE TWO GATES, in order:
 *   1. THE CLOCK MUST HAVE ROLLED. Before the first roll the trail's clock has no
 *      previous value, and in every PAUSED regime it never gets one — so a still
 *      render, and a drag in the editor, write nothing. This is what makes
 *      Δt = 0 ⟹ byte-identical structural rather than incidental.
 *   2. THE SPACING MUST HAVE ELAPSED. See trailSpacingSeconds.
 * Everything written is a function of `prev` plus the settled state, so repeating
 * this at one tick recomputes identical numbers and cannot trip
 * recordSimulationValue's two-consumers-disagreeing detector.
 *
 * @param {string} itemId - the sampled item's document id
 * @param {{x: number, y: number, seconds: number}} sample - the point and window
 * @param {number} age - the trail's settled clock this step, in seconds
 *
 * @example // advanceTrailHistory drives this; a direct call needs a rolled clock
 */
function advanceOne(itemId, sample, age) {
  const prevAge = recorded(clockKey(itemId));
  if (prevAge === null || !(age > prevAge)) return; // no roll yet, or a frozen clock: a trail does not move
  const spacing = trailSpacingSeconds(sample.seconds);
  const lastAge = recorded(ringKey(itemId, "last"));
  if (lastAge !== null && age - lastAge < spacing) return; // decimated
  const prevHead = recorded(ringKey(itemId, "head"));
  const head = prevHead === null ? 0 : (prevHead + 1) % TRAIL_SAMPLE_CAPACITY;
  recordSimulationValue(ringKey(itemId, "head"), head);
  recordSimulationValue(ringKey(itemId, "count"), Math.min((recorded(ringKey(itemId, "count")) ?? 0) + 1, TRAIL_SAMPLE_CAPACITY));
  // THE PHASE IS KEPT, NOT DISCARDED, and this is the difference between a trail
  // that holds the ring and one that holds two thirds of it. Writing `age` here
  // would restart the interval at each frame boundary, so a display whose frame is
  // not a divisor of the spacing samples every CEIL(spacing/frame) frames — 3 frames
  // at 100 fps against a 20.8 ms spacing is 30 ms, a 44% error, and a DIFFERENT
  // error at every frame rate (measured: 134 points at 100 fps vs 179 at 400 fps for
  // a window that should hold 192 at both). Advancing by whole spacings and carrying
  // the remainder locks the sample rate to 1/spacing exactly, which is what makes
  // "the picture is the same at 30 and at 144 fps" true rather than approximate.
  recordSimulationValue(ringKey(itemId, "last"), lastAge === null ? age : age - ((age - lastAge) % spacing));
  recordSimulationValue(cellKey(itemId, head, "x"), sample.x);
  recordSimulationValue(cellKey(itemId, head, "y"), sample.y);
  recordSimulationValue(cellKey(itemId, head, "age"), age);
}

/**
 * Query (reads the simulation table). `itemId`'s stored samples, OLDEST FIRST, with
 * the LIVE point appended as the tip — the list a renderer draws.
 *
 * Samples older than the window are dropped here as well as being overwritten by
 * the ring, so shortening `seconds` takes effect on the very next frame. A cell the
 * ring's own counters claim but that holds no value is impossible (the table
 * carries every written key forward until a reset drops them all) and is therefore
 * thrown on rather than skipped.
 *
 * @param {string} itemId - the sampled item's document id
 * @param {{x: number, y: number, seconds: number}} sample - the live point and window
 * @param {number} age - the trail's settled clock this step, in seconds
 * @returns {{x: number, y: number, age: number}[]} oldest → newest, always >= 1 long
 *
 * @example // a trail with no history yet is just its live point:
 * @example // resetSimulation(); trailHistoryPoints("t1", {x: 5, y: 7, seconds: 3}, 0) // [{x: 5, y: 7, age: 0}]
 */
export function trailHistoryPoints(itemId, sample, age) {
  const count = recorded(ringKey(itemId, "count")) ?? 0;
  const head = recorded(ringKey(itemId, "head")) ?? 0;
  const points = [];
  for (let i = 0; i < count; i++) {
    // count <= TRAIL_SAMPLE_CAPACITY, so head - (count - 1) + i is > -capacity and
    // the single += capacity below is enough to make the modulus non-negative.
    const index = (head - (count - 1) + i + TRAIL_SAMPLE_CAPACITY) % TRAIL_SAMPLE_CAPACITY;
    const x = recorded(cellKey(itemId, index, "x"));
    const y = recorded(cellKey(itemId, index, "y"));
    const sampleAge = recorded(cellKey(itemId, index, "age"));
    if (x === null || y === null || sampleAge === null)
      throw new Error(`trail_history: item "${itemId}" claims ${count} samples but ring cell ${index} is empty — the simulation table was written by something other than advanceTrailHistory`);
    if (age - sampleAge > sample.seconds) continue; // outside the authored window
    points.push({ x, y, age: sampleAge });
  }
  points.push({ x: sample.x, y: sample.y, age }); // THE TIP is live, never stored
  return points;
}

/**
 * Pure function. Do two point lists hold the same numbers? Used to keep the
 * INJECTED array's identity stable across the several evaluations of one frame —
 * a fresh array every call would churn every content-keyed memo downstream of the
 * evaluated state for no change in the picture.
 *
 * @param {object[]} a - points
 * @param {object[]} b - points
 * @returns {boolean}
 *
 * @example samePointList([{x: 1, y: 2, age: 0}], [{x: 1, y: 2, age: 0}]) // true
 * @example samePointList([{x: 1, y: 2, age: 0}], [{x: 1, y: 3, age: 0}]) // false
 * @example samePointList([], [{x: 1, y: 2, age: 0}]) // false
 */
export function samePointList(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.age === b[i].age);
}

/**
 * Command (advances every trail's history; MUTATES the evaluated state by injecting
 * TRAIL_POINTS_KEY onto each sampled item). THE ONE DRIVER — called from
 * web/cameraFrame.js evaluationAt, which is the seam every pixel consumer that has
 * a live clock reaches evaluation through.
 *
 * WHICH ITEMS: those whose plugin declares `trailSampler(itemState)`. A CAPABILITY
 * test, never a type test, per core/registry.js's law — so a future widget that
 * wants a streamer gets one by declaring the hook and nothing here changes.
 *
 * A SAMPLER THAT PRODUCES A NON-FINITE POINT IS REPORTED AND SKIPPED, not thrown
 * on: the pass must still produce a frame (the treatment core/expressions.js gives
 * a failing output-property injection), and the item keeps whatever points it
 * already had rather than poisoning the display list with NaN geometry.
 *
 * @param {object} state - an EVALUATED state ({items, vars}); mutated in place
 * @param {object} registry - the plugin registry
 *
 * @example // advanceTrailHistory(evaluateState(folded, registry).state, registry)
 */
export function advanceTrailHistory(state, registry) {
  for (const [id, item] of Object.entries(state.items ?? {})) {
    if (typeof item?.type !== "string") continue;
    const plugin = registry.get(item.type);
    if (!plugin?.trailSampler) continue;
    const sample = plugin.trailSampler(item);
    const age = item[TRAIL_CLOCK_KEY];
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !Number.isFinite(age) || !(sample.seconds > 0)) {
      const message = `trail "${id}" cannot be sampled: point (${sample.x}, ${sample.y}), clock ${age}, window ${sample.seconds} — one of them is not a usable number, so no sample was taken`;
      reportOnce(message, `PowerRP trail: ${message}`);
      continue;
    }
    advanceOne(id, sample, age);
    const points = trailHistoryPoints(id, sample, age);
    if (!samePointList(item[TRAIL_POINTS_KEY], points)) item[TRAIL_POINTS_KEY] = points;
  }
}
