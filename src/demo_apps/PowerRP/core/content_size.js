/**
 * CONTENT INTRINSIC SIZE — how big the thing INSIDE a widget actually is, made
 * readable from equations without breaking the determinism law.
 *
 * User, 2026-08-01: content intrinsic size must be readable FROM EQUATIONS
 * (PDF / image / video), plus a "bind aspect ratio to content" option.
 *
 * ── THE DIFFICULTY, STATED PLAINLY ───────────────────────────────────────────
 * `RenderTree = pure(document, [[slide, alpha]])`. An intrinsic size is NOT a
 * function of the document: it comes from a DECODED ASSET, asynchronously, from
 * the host. Reading one inside the equation jail would make `evaluateState`
 * impure — the exact thing core/expressions.js blocks `Date`, `fetch` and
 * `Math.random` to prevent — and would make two renders of one document differ.
 *
 * ── THE RESOLUTION: IT IS AN INPUT, NOT A LOOKUP ─────────────────────────────
 * The impurity is moved OUT. Measuring happens in the web layer (which already
 * does it — `pdfPagePointSize`, an <img>'s naturalWidth, a <video>'s videoWidth)
 * and the results are handed to `evaluateState` as a TABLE, exactly the way the
 * project script is. Given the same table the evaluation is as pure and as
 * memoizable as it ever was, and the table is part of the memo key so a size that
 * arrives late re-evaluates rather than serving a stale answer.
 *
 * This is the same shape as `time`: an ambient host value that the evaluator
 * never fetches for itself, only receives.
 *
 * ── UNMEASURED IS NOT ZERO ───────────────────────────────────────────────────
 * Before a decode lands there is no honest size, and the two tempting answers are
 * both wrong: 0 makes `w / aspect` divide by zero, and falling back to the
 * widget's CURRENT w/h silently returns the very number the author was trying to
 * derive, so a bound box would look correct and never actually track its content.
 * So an unmeasured item exposes NO `content` at all and an equation reading it
 * fails through the normal equation-error path — loudly, visibly, and
 * self-correcting the moment the decode lands.
 *
 * That window is exactly what `core/ephemeral.js` calls UNSETTLED, and the widgets
 * this serves (image / video / pdf_page) already declare `CONVERGES`. An exporter
 * that drains to settled therefore cannot photograph the unmeasured state.
 *
 * ── WHY IT RIDES THE ORDINARY PROPERTY PATH ──────────────────────────────────
 * The sizes are injected as a `content` object on the EVALUATED item state (never
 * the stored document), so `self.content.aspect` resolves through the SAME
 * {kind:"prop"} resolver every other property uses. No new grammar, no new
 * resolver branch, no fourth thing the highlighter and the display↔stored mappers
 * have to agree about — and `@logo.content.aspect` (another item's content) works
 * for free rather than as a second feature.
 */

/**
 * Pure function. The three numbers an author wants, from a measured size.
 *
 * `aspect` is width / height, the form that makes the common binding read
 * naturally (`= self.w / self.content.aspect` gives a height that matches the
 * content's shape).
 *
 * @param {{w: number, h: number}} size - a measured intrinsic size
 * @returns {{width: number, height: number, aspect: number}|null} null if the size is unusable
 *
 * @example contentFacts({w: 1920, h: 1080}) // {width: 1920, height: 1080, aspect: 1.7777777777777777}
 * @example contentFacts({w: 612, h: 792}) // {width: 612, height: 792, aspect: 0.7727272727272727}
 * @example contentFacts({w: 0, h: 100}) // null (a zero dimension has no aspect — refuse, never 0)
 * @example contentFacts(null) // null
 */
export function contentFacts(size) {
  const w = Number(size?.w), h = Number(size?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: w, height: h, aspect: w / h };
}

/**
 * Pure function. A state with `content` injected onto every item the table has a
 * measurement for — the ONE place intrinsic size enters evaluation.
 *
 * ITEMS WITHOUT A MEASUREMENT ARE LEFT EXACTLY AS THEY WERE, not given an empty
 * `content`: an equation reading `self.content.aspect` on an unmeasured item must
 * fail with "has no property", which is the truth, rather than read `undefined`
 * and quietly evaluate to NaN somewhere downstream.
 *
 * RETURNS THE INPUT UNCHANGED when the table is empty, so a document with no
 * measurable content pays nothing and is `===` to what it was — which keeps
 * evaluateState's identity-keyed memo working exactly as before.
 *
 * @param {object} state - a folded state ({items, vars})
 * @param {Map<string, {w: number, h: number}>|null} sizes - itemId → measured intrinsic size
 * @returns {object} the state, with content facts injected
 *
 * @example withContentSizes({items: {a: {type: "image"}}}, new Map([["a", {w: 200, h: 100}]])).items.a.content
 * // {width: 200, height: 100, aspect: 2}
 * @example withContentSizes({items: {a: {type: "image"}}}, new Map()).items.a.content // undefined
 * @example // an unusable measurement injects nothing rather than a zero aspect:
 * // withContentSizes({items: {a: {}}}, new Map([["a", {w: 0, h: 5}]])).items.a.content // undefined
 */
export function withContentSizes(state, sizes) {
  if (!sizes || sizes.size === 0) return state;
  let items = null;
  for (const [itemId, size] of sizes) {
    const item = state.items?.[itemId];
    if (!item) continue;
    const facts = contentFacts(size);
    if (!facts) continue;
    if (items === null) items = { ...state.items };
    items[itemId] = { ...item, content: facts };
  }
  return items === null ? state : { ...state, items };
}

/**
 * The equation an author gets from "bind height to content" — the height that
 * makes the widget match its content's shape at whatever width it has.
 *
 * A STORED EQUATION, NOT A ONE-OFF COMPUTATION, and that is the whole design of
 * the feature: it keeps tracking. Resize the widget and the height follows;
 * change the PDF's page and the height follows that too. The precedent is the
 * camera-bind command (core/registry.js CAMERA_BIND_HELP — "Write x / y / w / h
 * as equations reading THE camera's frame … and keeps tracking"), and it inherits
 * that precedent's escape hatch for free: the binding is an ordinary equation, so
 * it is visible in the Inspector, editable, and removable by typing a number.
 */
export const BIND_HEIGHT_TO_CONTENT = "= self.w / self.content.aspect";

/** The other direction, for a widget whose height is the fixed one. */
export const BIND_WIDTH_TO_CONTENT = "= self.h * self.content.aspect";
