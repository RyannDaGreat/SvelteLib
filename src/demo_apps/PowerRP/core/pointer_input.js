/**
 * THE AMBIENT POINTER INPUT — the (x, y, left) an equation reads through
 * `mouse_x` / `mouse_y` / `mouse_left`, and the deliberate SIBLING of
 * render_gpu/particle_clock.js.
 *
 * ── WHY THIS EXISTS (manifest R7-24) ─────────────────────────────────────────
 * User, verbatim: *"why mousex and mousey not exposed in equations?"* … and, when
 * asked which kind of state that would be: *"its recordable state … if it's
 * deterministic its good. that's it. its conceptual. not literally telling u to
 * record it."*
 *
 * So the pointer is being placed in the taxonomy's SECOND kind (PowerRP CLAUDE.md,
 * "The four kinds of state"), which is defined by HOW THE INPUT IS REACHED and not
 * by anything having been captured: recordable state is *"an ambient input …
 * that is not document state"*, read ONLY through a SEAM that the presenter drives
 * live, every still consumer freezes, and an exporter overrides per frame. `t` has
 * such a seam (particleTime); the pointer did not, which is the whole reason
 * `mouse_x` was absent rather than an oversight.
 *
 * ── THE THREE REGIMES, IN particleTime()'s PRECEDENCE ────────────────────────
 *   OVERRIDE  setPointerInputOverride(sample) wins over both regimes below.
 *             Tests, and the per-frame seam an exporter (or a future recorded
 *             pointer TRACK) drives — the analogue of setParticleTimeOverride.
 *   LIVE      startPointerFeed() opts a consumer INTO the live samples that
 *             samplePointer() writes. The presenter does this on mount
 *             (web/PresentMode.svelte) and stopPointerFeed() on exit.
 *   FROZEN    the DEFAULT, and therefore what every still consumer inherits for
 *             free: POINTER_REST. cli/render.js, the render-job page, the
 *             thumbnail/minimap/PNG pixel service and the settled editor all run
 *             here, so the kind's DEFINING TEST holds by construction — hold the
 *             ambient input and the document fixed and the frame is byte-identical.
 *
 * samplePointer() OUTSIDE the live regime is deliberately inert rather than an
 * error: a producer may run in a process where nothing consumes the pointer (the
 * editor's canvas), and the regime — not the producer — decides who is listening.
 *
 * ── THE ONE HONEST COST, STATED HERE SO IT IS NEVER DISCOVERED LATE ──────────
 * `t` is RE-DERIVABLE from a frame index; a pointer position is not. So an export
 * with no override renders the pointer FROZEN AT REST, and that is not a bug — it
 * is the only deterministic answer available. This is the same situation the
 * manifest already documents for a video PLAYER's current frame ("renders fine in
 * an export but is not reproducible"), and it is disclosed the same way: a deck
 * whose equations read these keywords attaches a warning to a render job
 * (server/server.py pointer_input_warning). It must not fail, and it must not
 * imply a reproducibility it does not have.
 *
 * ── ⚠ IF YOU WIRE THE *EDITOR* LIVE, FREEZE THE STILL CONSUMERS FIRST ────────
 * The freeze above is inherited by PROCESS: the CLI and the render-job page never
 * call startPointerFeed(), so nothing there can see a live sample. The editor is
 * NOT such a process — it HOSTS still consumers (web/gpuService.js's thumbnails
 * and minimap, the PNG export, and web/videoExport.createFrameSampler when a
 * client-backend job renders in the author's own tab). Today the editor never
 * starts the feed, so those are frozen and correct. A hook in
 * web/CanvasView.svelte that calls startPointerFeed() would change that, and it
 * MUST land together with a freeze at those seams (the shape to copy is
 * core/simulation_history.withSimulationFrozen, which exists for the identical
 * "one process, one live consumer, many frozen ones" problem). Wiring the hook
 * alone would make a thumbnail depend on where the mouse happened to be.
 *
 * ── WORLD COORDINATES, AND WHO CONVERTS ──────────────────────────────────────
 * `x`/`y` are WORLD units — the same space an item's `x`/`y` live in — because the
 * point of the feature is `x = mouse_x` on a cursor widget. A producer therefore
 * inverts its OWN view mapping before calling samplePointer() (the presenter has
 * worldPointOf(), which inverts the very fitRectView the frame was painted with).
 * Storing screen pixels here would make the value mean something different on
 * every display, and a deck authored on one would be wrong on the next.
 *
 * ── WHY core/ AND NOT render_gpu/, BESIDE particle_clock.js ──────────────────
 * particle_clock's docblock puts itself in render_gpu/ "because it is a MUTABLE
 * ambient service … not pure like core/particles.js". That reason no longer
 * separates the two directories: core/simulation_history.js (R7-9) and
 * core/live_control.js are both mutable ambient services in core/. live_control is
 * in fact the exact precedent for THIS module and says so — live HOST input, "the
 * PRESENTER and the EDITOR are two callers that must not each keep their own
 * answer", in core/ "because a bare-node test can then pin the set's transitions
 * without a browser". Both apply here verbatim. render_gpu/ is "the display-list
 * renderer family" and this module touches no display list; its principal consumer
 * (core/expressions.js) is in core/, so this also avoids deepening the one
 * core → render_gpu import edge rather than adding a second.
 *
 * DOM-free and bare-node runnable, like the rest of core/: nothing here reads a
 * window, an event or a clock.
 */

/**
 * THE FROZEN POINTER — what every still consumer sees, and what an export with no
 * override renders. World origin, button up.
 *
 * It is a CONSTANT rather than "wherever the pointer was last seen" because the
 * frozen regime must not depend on a session's history: the CLI, a render worker
 * and the editor must all agree on the resting frame, and only a constant does
 * that. It is also the identity every memo comparison below leans on.
 */
export const POINTER_REST = Object.freeze({ x: 0, y: 0, left: false });

/**
 * THE KEYWORDS, and the field of a sample each one reads — ONE table, because
 * three consumers need it and a second copy is how `dt` nearly shipped
 * undiscoverable (core/expressions.js RESERVED_KEYWORDS' own docblock).
 * core/expressions.js folds these names into RESERVED_KEYWORDS (which is what makes
 * all four grammar passes and the autocomplete agree about them) and calls the
 * accessor in scopeGet; server/server.py's export warning matches the same names.
 *
 * `mouse_left` is the BUTTON HELD, not a click EVENT. The user wrote
 * "mouse_left_clicked", and a click is a moment rather than a value — the thing
 * core/live_control.js's ruling already refuses to make into a leaf ("a
 * button/key PRESS is LIVE — a moment is not a value"). A held state IS a value at
 * every instant, so it is what an equation can read; events belong to R7-8's
 * trigger work. The shorter name says "state" rather than "event" and is the
 * spelling the manifest's own worked example uses (R7-25:
 * `= mouse_left ? "handgrabbing" : "handpointing"`).
 *
 * @example Object.keys(POINTER_KEYWORDS) // ["mouse_x", "mouse_y", "mouse_left"]
 * @example POINTER_KEYWORDS.mouse_x(POINTER_REST) // 0
 * @example POINTER_KEYWORDS.mouse_left({x: 1, y: 2, left: true}) // true
 */
export const POINTER_KEYWORDS = Object.freeze({
  mouse_x: (sample) => sample.x,
  mouse_y: (sample) => sample.y,
  mouse_left: (sample) => sample.left,
});

/** The LIVE sample, replaced only when a field actually differs (see
 *  samplePointer) so its IDENTITY is a valid "has the pointer moved?" test. */
let liveSample = POINTER_REST;

/** true while a consumer has opted into the live samples (startPointerFeed). */
let feedLive = false;

/** An explicit override sample, or null. Wins over BOTH regimes. */
let overrideSample = null;

/**
 * Pure function. `{x, y, left}` normalized and FROZEN, or a thrown error naming
 * the offender. A non-finite coordinate is refused rather than stored: it would
 * reach every equation reading `mouse_x` and surface as a widget that silently
 * vanished, which is the failure core/view.fitRectView already guards its own
 * degenerate case against ("any pointer position derived from it became NaN").
 *
 * @param {number} x - world x
 * @param {number} y - world y
 * @param {boolean} left - is the LEFT button held down right now
 * @returns {{x: number, y: number, left: boolean}} frozen
 *
 * @example pointerSample(120, -40, true) // {x: 120, y: -40, left: true}
 * @example pointerSample(0, 0, false) // {x: 0, y: 0, left: false} (equals POINTER_REST)
 * @example // pointerSample(NaN, 0, false) // throws: "PowerRP pointer input: x must be finite, got NaN"
 */
export function pointerSample(x, y, left) {
  if (!Number.isFinite(x)) throw new Error(`PowerRP pointer input: x must be finite, got ${x}`);
  if (!Number.isFinite(y)) throw new Error(`PowerRP pointer input: y must be finite, got ${y}`);
  if (typeof left !== "boolean") throw new Error(`PowerRP pointer input: left must be a boolean, got ${typeof left}`);
  return Object.freeze({ x, y, left });
}

/**
 * Query. The pointer an equation reads RIGHT NOW. Precedence:
 *   1. an explicit override (setPointerInputOverride) — tests / exporters;
 *   2. the last live sample, while a feed is running (the presenter);
 *   3. POINTER_REST — the frozen default (editor stills, CLI, thumbnails, export).
 *
 * Near-pure (reads module state); PURE and CONSTANT in the frozen regime, which is
 * what makes every still render byte-reproducible.
 *
 * THE RETURNED OBJECT'S IDENTITY IS STABLE while the pointer has not moved, and
 * core/expressions.js's evaluation memo compares it with `===`. So a stationary
 * pointer costs an equation-reading document exactly nothing, and a moved one
 * invalidates on the first read — the same contract `clock` has, by value there and
 * by identity here because a sample is a record rather than a number.
 *
 * @returns {{x: number, y: number, left: boolean}} frozen
 *
 * @example pointerInput() // {x: 0, y: 0, left: false} — the default frozen regime
 * @example // startPointerFeed(); samplePointer(30, 40, true); pointerInput() // {x: 30, y: 40, left: true}
 */
export function pointerInput() {
  if (overrideSample !== null) return overrideSample;
  if (feedLive) return liveSample;
  return POINTER_REST;
}

/**
 * Command (module state). Records where the pointer is, in WORLD units. Called by
 * the live producer on every pointer event; INERT unless a feed is running, so a
 * producer never has to ask whether anyone is listening.
 *
 * A sample equal to the current one is DROPPED rather than re-stored, which is what
 * keeps pointerInput()'s identity stable — and therefore what keeps a stationary
 * pointer from invalidating the evaluation memo once per mouse event.
 *
 * @param {number} x - world x
 * @param {number} y - world y
 * @param {boolean} left - is the LEFT button held down right now
 * @returns {boolean} did the stored sample CHANGE (the producer's "repaint?" answer)
 *
 * @example // startPointerFeed(); samplePointer(5, 6, false) // true (moved)
 * @example // samplePointer(5, 6, false) // false (unchanged — no repaint needed)
 * @example // stopPointerFeed(); samplePointer(9, 9, true) // false (no feed: inert)
 */
export function samplePointer(x, y, left) {
  if (!feedLive) return false;
  const next = pointerSample(x, y, left);
  if (next.x === liveSample.x && next.y === liveSample.y && next.left === liveSample.left) return false;
  liveSample = next;
  return true;
}

/**
 * Command. Opens the LIVE regime, starting FROM REST — the presenter calls this on
 * mount. Re-basing to rest rather than to the last session's sample is the same
 * rule startParticleClock(t0 = 0) follows: a presentation begins from the authored
 * initial condition, not from wherever the previous one stopped.
 *
 * @example // startPointerFeed(); isPointerFeedLive() // true, pointerInput() === POINTER_REST
 */
export function startPointerFeed() {
  liveSample = POINTER_REST;
  feedLive = true;
}

/**
 * Command. Returns pointerInput() to the FROZEN regime (presenter exit), and drops
 * the live sample so nothing renders a still at the last presented position.
 *
 * @example // stopPointerFeed(); pointerInput() === POINTER_REST // true
 */
export function stopPointerFeed() {
  feedLive = false;
  liveSample = POINTER_REST;
}

/** Query. Is a live pointer feed running? (Presenter-state introspection; tests.)
 * @example isPointerFeedLive() // false by default */
export function isPointerFeedLive() {
  return feedLive;
}

/**
 * Command. Forces pointerInput() to return exactly `sample` (overriding both
 * regimes), or clears the override when passed null.
 *
 * THIS IS THE POINT OF THE WHOLE DESIGN, not a test hook bolted on: a future
 * recorded pointer TRACK (manifest R7-24's § B-1 session recorder) is just another
 * supplier of this override, driven per frame the way
 * web/videoExport.createFrameSampler already drives setParticleTimeOverride — and
 * NOTHING in this module, in the grammar, or in any consumer changes when one
 * arrives. Until then it is used by tests and available to any exporter that has a
 * pointer to dictate.
 *
 * @param {?{x: number, y: number, left: boolean}} sample - the dictated pointer, or null to clear
 * @returns {void}
 *
 * @example // setPointerInputOverride({x: 7, y: 8, left: true}); pointerInput() // {x: 7, y: 8, left: true}
 * @example // setPointerInputOverride(null); pointerInput() // back to its regime
 */
export function setPointerInputOverride(sample) {
  if (sample === null) {
    overrideSample = null;
    return;
  }
  overrideSample = pointerSample(sample.x, sample.y, sample.left);
}
