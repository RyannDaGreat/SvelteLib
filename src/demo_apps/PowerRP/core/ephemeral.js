/**
 * EPHEMERALITY — the fourth thing a widget must say about itself, alongside what
 * it is, what it defaults to, and what it draws.
 *
 * ── WHY THIS IS A REQUIRED FIELD AND NOT A CONVENTION ────────────────────────
 * USER RULING, 2026-08-01: *"This needs to be not just a convention but
 * structurally part of the definition of a widget."* He is right, and the reason
 * is measurable rather than stylistic. Before this file, "wait for me before you
 * capture a frame" was an OPT-IN: `web/gpuService.js` awaited exactly one seam
 * (`prepareSceneScrubFrames`, for video scrubbers), two widget families had
 * remembered to add themselves, and every other async widget silently had not. So
 * an mp4 export of a deck containing a PDF shipped a hole, and the user found it
 * the only way anyone could — by watching his PDF not be there.
 *
 * A convention fails here for a structural reason: THE CONSUMER CANNOT KNOW WHAT
 * IT HAS NOT HEARD OF. An exporter iterating a list of prepare-hooks is correct
 * only for the widgets whose authors thought about export. Making the declaration
 * REQUIRED inverts that — a widget that has not answered cannot register, so a new
 * async widget is correct by construction instead of by remembering.
 *
 * ── WHAT "SETTLED" MEANS, IN THE USER'S OWN TERMS ────────────────────────────
 * SETTLING IS CONVERGENCE, NOT READINESS. *"When I zoom into the PDF, or zoom out
 * or move something, the PDF viewer will make it temporarily lower resolution.
 * That is a form of ephemeral state. It does that to avoid lag. When the camera
 * doesn't move for a while, eventually it will settle on a higher resolution
 * version, and then it doesn't change anymore. That's what I mean by settling."*
 *
 * So a widget with progressive refinement draws a CHEAP tier while the view is in
 * motion and an expensive accurate one once it holds still. SETTLED means it has
 * reached its fixed point: another frame at the same state yields identical
 * pixels. Loading is the DEGENERATE case where the cheap tier is "nothing at all"
 * — which is why framing this as "has it loaded" was too narrow, a boolean where
 * the real thing is a limit.
 *
 * ── WHY IT IS EPHEMERAL, PRECISELY ───────────────────────────────────────────
 * The unsettled output is a function of HISTORY, not of state. Which tier the PDF
 * is showing right now depends on how recently the camera moved — on the
 * trajectory that got you here, not on where you are. Same document, same
 * `[[slide, alpha]]`, different pixels depending on what the user just did with
 * the mouse. Concretely, the tier scheduler reads a WALL CLOCK. That is what
 * disqualifies it from being property state (not computable from `[[slide,
 * alpha]]`) or recordable state (not a function of `t`), and it fails the Δt test
 * in CLAUDE.md outright: hold `t` and the document fixed, render either side of an
 * upgrade, get two different frames.
 *
 * ── EPHEMERAL IS THE LEAST DESIRED KIND, AND THE THREE ANSWERS ARE NOT PEERS ─
 * USER RULING, 2026-08-01, and it governs every use of this field: *"ephemeral is
 * the least desired state type. It really should be as minimal as possible ever.
 * We really want to get away from ephemeral state because it's not deterministic.
 * The settled state of rendering should always be deterministic, and ephemeral can
 * be a cheap way to get there without being too laggy — for example when PDF
 * temporarily goes lower resolution. But that's all ephemeral state should ever
 * really be used for."*
 *
 * So this is a RANKING, not a menu:
 *   NONE is the goal. Reach for it first, always.
 *   CONVERGES is TOLERATED, and for exactly one purpose — buying interactivity on
 *     the way to an answer that is already determined. Its licence therefore comes
 *     with a law: THE LIMIT MUST BE DETERMINISTIC. A CONVERGES widget must settle
 *     to the SAME pixels regardless of the path taken to get there — same
 *     document, same `[[slide, alpha]]`, same settled frame, whether the user
 *     zoomed in slowly, jumped straight there, or rendered it headlessly. Only the
 *     TRANSIENT may vary. A widget whose settled output depends on how it got
 *     there is not using this category, it is smuggling ephemerality past it.
 *   NEVER is a DEFECT, not a third design option. It is spelled here so a
 *     non-converging widget must confess rather than silently poison an export,
 *     and so exporters can name it. Adding a NEW one needs a very good reason;
 *     the existing inhabitant is grandfathered, not endorsed.
 *
 * The practical test before writing CONVERGES: *could this just be NONE if I did
 * the work eagerly?* If the only thing the cheap tier buys is avoiding a stall,
 * you are in scope. If it is buying correctness, or hiding an unfinished
 * calculation, you are not — fix the calculation.
 *
 * ── THE THREE ANSWERS, AND WHY EXACTLY THREE ─────────────────────────────────
 * Settling is what REHABILITATES ephemeral state, and that is the axis the old
 * taxonomy was missing. Treating ephemeral as uniformly forbidden is too blunt: a
 * widget whose ephemeral component CONVERGES is perfectly renderable, you simply
 * wait for it. One that never converges is not renderable at any price. So the
 * real line is converging vs non-converging, and the vocabulary is:
 *
 *   NONE      — no cheap tier. Correct on the first frame, forever. Every vector
 *               shape, every text widget. Trivially settled, costs a consumer
 *               nothing.
 *   CONVERGES — has a cheap tier or an async source, and reaches a fixed point.
 *               PDF, image, LaTeX, Mermaid, scene3d, the splat viewer. MUST
 *               supply `settled(ctx)`; a consumer drains it before capture.
 *   NEVER     — genuinely non-converging, and honest about it. The video PLAYER
 *               is the one real inhabitant: `gpu/video_registry.js` has no
 *               time-override seam because the <video> element runs on the
 *               browser's own clock DELIBERATELY (a player's playing is not
 *               document state). It cannot be fixed by waiting, so an exporter
 *               must refuse or freeze it BY NAME rather than silently ship
 *               whichever frame happened to be decoded.
 *
 * PARTICLES ARE NOT IN THIS TAXONOMY AT ALL, and the user caught himself on it
 * mid-sentence: *"actually, no, particle effects does settle, just
 * deterministically given a certain time step. Because particle effects are not
 * ephemeral state."* Right — they are RECORDABLE state, a pure function of `t`
 * (`render_gpu/particle_clock.particleTime`). A widget whose output varies with
 * `t` alone declares NONE: at a FIXED `t` it is immediately correct, which is the
 * only question this field asks.
 *
 * ── THE PREDICATE IS "WOULD ANOTHER FRAME CHANGE ME", NOT "ARE YOU READY" ────
 * That phrasing matters because it serves two masters with one answer. An
 * exporter needs it to know when capture is SAFE; the editor needs it to know
 * when it may STOP repainting. A readiness flag answers only the first.
 */

/**
 * The ephemerality vocabulary. Frozen and exported as the ONE spelling — a
 * plugin declaring a bare string that happens to match is still valid (the gate
 * compares values, not identity), but the constants are what the roster uses so
 * a typo is a missing-key error at author time rather than a silent mismatch.
 */
export const EPHEMERAL = Object.freeze({
  NONE: "none",
  CONVERGES: "converges",
  NEVER: "never",
});

/** Every legal answer, for the registration gate's error message. */
export const EPHEMERAL_KINDS = Object.freeze(Object.values(EPHEMERAL));

/**
 * Pure function. Is `decl` a well-formed ephemerality declaration? A bare kind
 * string for NONE and NEVER; for CONVERGES an object `{kind, settled}` where
 * `settled` is the predicate a consumer drains on.
 *
 * CONVERGES MUST CARRY ITS PREDICATE, and that is the whole reason this is not
 * just an enum: a widget that says "I converge" without saying HOW has told a
 * consumer nothing it can act on, which is the opt-in failure this replaces
 * wearing a new hat.
 *
 * @param {string|object} decl - the plugin's `ephemeral` field
 * @returns {boolean}
 *
 * @example isEphemeralDecl("none") // true
 * @example isEphemeralDecl("never") // true
 * @example isEphemeralDecl({kind: "converges", settled: () => true}) // true
 * @example isEphemeralDecl("converges") // false — it owes a settled() predicate
 * @example isEphemeralDecl({kind: "converges"}) // false — same, spelled as an object
 * @example isEphemeralDecl("maybe") // false
 * @example isEphemeralDecl(undefined) // false
 */
export function isEphemeralDecl(decl) {
  if (typeof decl === "string") return decl === EPHEMERAL.NONE || decl === EPHEMERAL.NEVER;
  if (!decl || typeof decl !== "object") return false;
  return decl.kind === EPHEMERAL.CONVERGES && typeof decl.settled === "function";
}

/**
 * Pure function. The KIND of a declaration, whichever spelling it used.
 *
 * @param {string|object} decl - a well-formed declaration
 * @returns {string} one of EPHEMERAL_KINDS
 *
 * @example ephemeralKind("none") // "none"
 * @example ephemeralKind({kind: "converges", settled: () => true}) // "converges"
 */
export function ephemeralKind(decl) {
  return typeof decl === "string" ? decl : decl.kind;
}

/**
 * Query (calls each widget's own `settled` predicate, which reads live raster
 * state). The widgets in `entries` that have NOT yet settled, as
 * `{itemId, type, kind}` records — empty when the scene is safe to capture.
 *
 * RETURNS THE OUTSTANDING SET, NOT A BOOLEAN, because every caller needs the
 * names: an exporter that stalls must say WHICH widget never converged, and
 * "the render timed out" is the unactionable sentence this codebase keeps
 * finding in its own logs. NEVER-settling widgets are reported too, on their
 * first appearance, so a consumer can decide policy (refuse, or freeze and warn)
 * with the offender named — cli/render.js already sets that precedent by
 * counting and reporting what it could not draw.
 *
 * @param {Array<{itemId: string, plugin: object, state: object}>} entries - the scene's widgets
 * @param {object} ctx - passed to each `settled(state, ctx)`; the consumer's view/quality
 * @returns {Array<{itemId: string, type: string, kind: string}>}
 *
 * @example // every widget is a plain vector shape:
 * @example unsettledIn([{itemId: "a", plugin: {type: "rect", ephemeral: "none"}, state: {}}], {}) // []
 * @example // a converging widget that says it has not finished:
 * @example unsettledIn([{itemId: "p", plugin: {type: "pdf_page", ephemeral: {kind: "converges", settled: () => false}}, state: {}}], {}) // [{itemId: "p", type: "pdf_page", kind: "converges"}]
 * @example // the same widget once its high-resolution tier has landed:
 * @example unsettledIn([{itemId: "p", plugin: {type: "pdf_page", ephemeral: {kind: "converges", settled: () => true}}, state: {}}], {}) // []
 */
export function unsettledIn(entries, ctx) {
  const out = [];
  for (const { itemId, plugin, state } of entries) {
    const kind = ephemeralKind(plugin.ephemeral);
    if (kind === EPHEMERAL.NONE) continue;
    if (kind === EPHEMERAL.NEVER) { out.push({ itemId, type: plugin.type, kind }); continue; }
    if (!plugin.ephemeral.settled(state, ctx)) out.push({ itemId, type: plugin.type, kind });
  }
  return out;
}
