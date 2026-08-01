/**
 * WHICH OF AN ITEM'S STORED LEAVES HOLD AN `=` EQUATION — the one query, the
 * projection built from it, and the SENTENCE a refused gesture explains itself
 * with.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * "Is this stored leaf an equation, and would my gesture overwrite it?" is asked
 * all over the canvas side of the app, and it had been ANSWERED four times, in
 * four files, with the same three-part expression: read the RAW stored value
 * (`app.storedItemValue`), hand it to `isEquationValue` with its path, and act on
 * the ones that come back true. The four:
 *
 *   web/interiorNav.js          equationBoundInteriorProps — double-click explore
 *                               refuses when a view property is bound
 *   web/CanvasToolbar.svelte    boundKeys — a floating-bar field/toggle disables
 *                               when a leaf it would write is bound
 *   web/app.svelte.js           beginTextEdit — in-place text editing refuses
 *   web/canvas/dragKinds.js     (via CanvasView) — R6-28 equation lock, the
 *                               caller that would have been the FIFTH
 *
 * They agree today. Nothing made them agree, and the ledger's measured lesson is
 * that a fifth copy appears while the fourth is being written
 * (CONVENTION_LEDGER C-10). So the expression lives here once, every caller reads
 * it, and the DIVERGENCE GATE in tests/equation_lock_test.js fails when a new copy
 * appears. (This line used to name `tests/equation_binding_test.js`, a file that
 * has never existed in any commit — a citation to a nonexistent gate is worse than
 * none, because it tells the next reader the invariant is protected while nothing
 * checks that claim.)
 *
 * ── THE MODULE IS NAMED FOR THE QUERY, NOT FOR THE FEATURE ───────────────────
 * Lead ruling, 2026-08-01: the R6-28 equation LOCK prompted the extraction, but
 * two of the four consumers have nothing to do with locking, and a module called
 * `equationLock.js` would read as lock-specific to the next author — who would
 * then write the fifth copy anyway. `equationPinning` lives here too because it
 * is a one-line consequence of the query (the keys it finds, handed to
 * core/derive.pinning) and because a module with one consumer is the speculative
 * generality ledger C-1 forbids.
 *
 * ── AND THE REFUSAL SENTENCE, BECAUSE IT IS DOMAIN LOGIC, NOT VIEW LOGIC ──────
 * `equationLockNote` shipped inside web/CanvasView.svelte and was reachable from
 * exactly one caller there — the resize-handle affordance — so a body drag and a
 * yellow square refused in silence while the same condition on a corner explained
 * itself. That is todo #240. It sits here for the reason core/commands.js keeps
 * `commandUnavailableReason` out of the palette: a refusal is a statement about
 * the DOCUMENT, and every surface that has to make one must be able to reach the
 * same words, or "one condition, one voice" is a hope rather than a fact.
 *
 * It being here also puts it inside a gate. tests/doctest_test.js:629 collects
 * `.js` files ONLY, so the two `@example` records this function carried in a
 * `.svelte` file had never been executed by anything, in any run — an example
 * exercising a path with no caller, certifying a feature that did not exist.
 *
 * DOM-free: imports core/expressions + core/derive only, so it runs in bare node
 * and its behaviour is pinned by a node suite rather than by a browser probe.
 */

import { isEquationValue } from "../../core/expressions.js";
import { pinning } from "../../core/derive.js";

/**
 * Query (reads the document through `app`). Which of `keys` are bound to an `=`
 * equation on item `itemId`, in the order given. Empty when none are.
 *
 * A key is a DOTTED STORED PATH within the item — the vocabulary
 * web/canvas/dragKinds.js geometryPairs already speaks, so a bbox widget's flat
 * `"w"` and an arrow's `"from.x"` are both askable with no branch here. Every key
 * in use today is single-segment, so the split is a superset rather than a
 * change.
 *
 * THE RAW STORED VALUE IS WHAT IS READ, never the evaluated one: an equation is
 * only still an equation before evaluateState resolves it to the number the
 * canvas is showing. Asking the derived state would answer "no" for every bound
 * leaf in the app.
 *
 * @param {object} app - the app store
 * @param {string} itemId - the item whose stored leaves are read
 * @param {object} plugin - that item's plugin (isEquationValue needs its defaults
 *   to recognise the legacy BARE-STRING equation in a numeric slot)
 * @param {string[]} keys - dotted stored paths within the item
 * @returns {string[]} the subset of `keys` that hold an equation
 */
export function equationBoundKeys(app, itemId, plugin, keys) {
  return keys.filter((key) => {
    const path = key.split(".");
    return isEquationValue(plugin, path, app.storedItemValue(itemId, path));
  });
}

/**
 * Query (reads the document through `app`). THE EQUATION-LOCK PROJECTION for one
 * item: a `constrain(state, desired) → allowed` (core/derive.js THE
 * HANDLE-CONSTRAINT PROTOCOL) that holds every coordinate of `desired` whose
 * stored leaf is an equation at the value it had when the gesture started.
 *
 * IT IS A `pinning`, WHICH IS THE WHOLE POINT (R6-28). Axis suppression, the
 * modal G/S axis constraint and this lock are one mathematical object — project
 * the desired record onto the nearest point of an axis-aligned affine subspace —
 * so the lock enters at the ONE seam every drag already goes through
 * (web/canvas/dragKinds.js geometryPairs) instead of becoming a second
 * interaction layer that every future gesture would have to remember. A pinned
 * coordinate comes back equal to its start value, and `diffState` then drops it
 * for the same reason it drops one that merely did not move: the equation is not
 * written, not overwritten-with-itself.
 *
 * THE KEY SET IS READ OFF `desired`, so a gesture that never mentions a
 * coordinate cannot be slowed down by a lock on it, and there is no key list to
 * keep in step with the gestures.
 *
 * IT DOES NOT READ THE TOGGLE. Whether the lock is armed is the caller's
 * question (web/CanvasView.svelte asks it once, in `dragConstraint`), so this
 * function stays a statement about the document rather than about app state, and
 * the test suite can exercise it with no toggle in the picture.
 *
 * @param {object} app - the app store
 * @param {string} itemId - the item being dragged
 * @param {object} plugin - that item's plugin
 * @returns {function} a `constrain(state, desired) → allowed`
 */
export function equationPinning(app, itemId, plugin) {
  return (state, desired) =>
    pinning(equationBoundKeys(app, itemId, plugin, Object.keys(desired)))(state, desired);
}

/**
 * Pure function. The sentence a locked canvas affordance explains itself with.
 *
 * IT IS COMPUTED, NOT A CONSTANT, for the reason core/commands.js already records
 * for a command's `requires`: a gate with several disqualifying conditions has
 * several true sentences, and one fixed string would be a confident wrong answer
 * for all but one. Here the variable parts are WHICH properties are bound and
 * WHICH gesture was refused — which is exactly what the user asked the tip to say.
 *
 * THE VOICE IS THE ONE THIS CONDITION ALREADY HAS. "`x` is an = equation — edit it
 * in the Inspector" is web/app.svelte.js beginTextEdit's refusal, web/interiorNav.js's
 * refusal and web/CanvasToolbar.svelte's disabled-field tip, word for word; one
 * condition, one voice. What is added is the clause only this feature can say: the
 * lock is a TOGGLE, so switching it off is a second way out that those three do not
 * have.
 *
 * `verb` IS THE GESTURE'S OWN WORD, and every surface passes its own: "move" for a
 * body drag, "resize" for a bbox handle, "drag this point" for a modifier point
 * (the noun the point commands use — hide-points / purge-points). It is a parameter
 * rather than derived from the keys because the SAME key set refuses different
 * gestures — a bound `x` stops a move and leaves an east-edge resize alone — so a
 * sentence inferred from the keys would name the wrong gesture half the time.
 *
 * @param {string[]} keys - the stored keys the lock refused, in the gesture's order
 * @param {string} verb - what the gesture would have done ("move", "resize", …)
 * @returns {string}
 *
 * @example equationLockNote(["h"], "resize") // 'Cannot resize: "h" is an = equation — Equation Lock is on. Edit it in the Inspector, or switch the lock off.'
 * @example equationLockNote(["x", "w"], "move") // 'Cannot move: "x", "w" are = equations — Equation Lock is on. Edit them in the Inspector, or switch the lock off.'
 * @example equationLockNote(["innerRadius"], "drag this point") // 'Cannot drag this point: "innerRadius" is an = equation — Equation Lock is on. Edit it in the Inspector, or switch the lock off.'
 */
export function equationLockNote(keys, verb) {
  const one = keys.length === 1;
  const named = keys.map((k) => `"${k}"`).join(", ");
  return `Cannot ${verb}: ${named} ${one ? "is an" : "are"} = equation${one ? "" : "s"} — Equation Lock is on. Edit ${one ? "it" : "them"} in the Inspector, or switch the lock off.`;
}
