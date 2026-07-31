/**
 * THE ERROR AFFORDANCE — one shape, one palette, for every way a widget can be
 * unpaintable. DOM-free pure JS (bare-node testable), and in `core/` rather than
 * `render_gpu/` because core/plugin_assets.js is one of its three callers and
 * core may not import render_gpu (the layering rule).
 *
 * WHY THIS FILE EXISTS. The same containment shipped three times, piecemeal,
 * each time as a response to one live crash:
 *
 *   50a50bc  a plugin's emit() threw ("triangulated: no ear found") → red box
 *   ba25b39  a node's world transform was non-finite → red box at emitNode
 *   d545ddc  a fill-only material ("crt") landed in a stroke slot →
 *            getStrokeMaterial threw INSIDE THE PAINTER, every frame
 *
 * The third one is why the general boundary had to exist. Its blast radius was
 * not one frame: autosave faithfully restored the poisoned document on every
 * boot, so the app was BRICKED across reloads until the user cleared
 * localStorage by hand ("Oh no, I put it into a crash permaloop — now every time
 * the page loads it crashes"). Each of the three fixes guarded the one seam that
 * had just burned; none of them covered the next one.
 *
 * THE DOCTRINE, stated once so the next case is covered before it happens. A
 * BRICK IS THE QUIETEST FAILURE OF ALL — the user cannot even see the error, and
 * a codebase that forbids silent failure must forbid that hardest. Loud failure
 * is therefore satisfied by REPORT + AFFORDANCE, not by dying: the console
 * carries the real error once (with its stack, so a determinism bug is never
 * masked), the canvas carries a red box naming the item, and every other widget
 * still paints. This is containment, NOT a fallback that papers over ignorance:
 * nothing is guessed, nothing is retried, and the failure is louder after this
 * change than before it, because before it the only signal was a blank screen.
 */

/**
 * Command (marks and returns `e`). Brand an error as a BACKEND-CONFIGURATION
 * failure, which the per-node boundaries must RETHROW rather than contain.
 *
 * THE LINE THE BOUNDARY DRAWS, and why it needs marking at all. Containment is
 * for POISON IN THE DOCUMENT — one item whose material, numbers or plugin code
 * cannot be drawn. It is NOT for a caller who wired the backend up wrong: an SVG
 * or PDF export asked to rasterize with no rasterize callback is broken for the
 * WHOLE export, in a way no red box on one item honestly describes. Containing
 * it would turn a loud, correct refusal into forty red boxes and a "successful"
 * export — the silent failure this codebase forbids, wearing the costume of the
 * mechanism meant to prevent it.
 *
 * MARKED, NOT PATTERN-MATCHED. The alternative — sniffing the message text for
 * "rasterize callback" — would silently stop working the day someone rewords the
 * message, and would misfire on a plugin that happened to say the same words. A
 * flag set at the throw site is checked where it is meant and nowhere else.
 *
 * @param {Error} e - the error to brand
 * @returns {Error} the same error, marked
 *
 * @example configurationError(new Error("no rasterize callback")).isBackendConfiguration
 * true
 * @example // it is the same object, so `throw configurationError(new Error("x"))` reads naturally
 * isConfigurationError(configurationError(new Error("x")))
 * true
 */
export function configurationError(e) {
  e.isBackendConfiguration = true;
  return e;
}

/**
 * Pure function. Must this error escape the per-node boundary untouched?
 *
 * @param {*} e - whatever reached a catch
 * @returns {boolean}
 *
 * @example isConfigurationError(new Error("unknown material \"crt\""))
 * false
 * @example isConfigurationError(configurationError(new Error("no rasterize callback")))
 * true
 * @example isConfigurationError("a bare string throw")
 * false
 */
export function isConfigurationError(e) {
  return !!(e && e.isBackendConfiguration);
}

/**
 * The loud red treatment (render_gpu/affordances.js's palette), as ALREADY-PARSED
 * rgba arrays in 0..1 — the exact form `render_gpu/ir.js parseColor` produces for
 * the hex literals #f6c9c4 / #c0392b / #7a1210.
 *
 * WHY PARSED AND NOT HEX, which cost a real bug to learn: `parsePaint` accepts
 * both, but a hex STRING that reaches a backend without going through it draws
 * NOTHING — the PDF and SVG writers index a colour array, and a string silently
 * yields an op with no paint. The first cut of this module emitted hex, and the
 * contained item VANISHED instead of turning red: the containment mechanism
 * failing in exactly the silent way it exists to prevent. Arrays are inert here
 * and correct everywhere, and core/ still imports nothing from render_gpu.
 */
export const ERROR_BG = [0.9647058823529412, 0.788235294117647, 0.7686274509803922, 1];        // #f6c9c4
export const ERROR_BORDER = [0.7529411764705882, 0.2235294117647059, 0.16862745098039217, 1];  // #c0392b
export const ERROR_TEXT = [0.47843137254901963, 0.07058823529411765, 0.06274509803921569, 1];  // #7a1210
const ERROR_BORDER_WIDTH = 3;
const ERROR_PADDING = 8;
/** Text height as a fraction of the box — a label that scales with the widget
 *  instead of vanishing on a big one or overflowing a small one. */
const ERROR_TEXT_FRACTION = 0.16;
/** The box a broken widget occupies when its own state carries no usable w/h.
 *  Visible and findable: a 0×0 affordance would be the silent failure again. */
export const ERROR_FALLBACK_SIZE = 160;

/**
 * Pure function. A usable positive extent, or the visible fallback — the guard
 * that keeps an affordance from inheriting the very numbers that broke the node.
 *
 * @param {*} v - a stored w or h (may be NaN, negative, undefined, a string)
 * @returns {number} v when it is finite and positive, else ERROR_FALLBACK_SIZE
 *
 * @example errorBoxExtent(240)
 * 240
 * @example errorBoxExtent(NaN)
 * 160
 * @example errorBoxExtent(0)
 * 160
 */
export function errorBoxExtent(v) {
  return Number.isFinite(v) && v > 0 ? v : ERROR_FALLBACK_SIZE;
}

/**
 * Pure function. THE ERROR AFFORDANCE as builder ARGUMENTS: the geometry and
 * colours of a red-bordered box with a message, in LOCAL space at the origin.
 *
 * ARGUMENTS, NOT FINISHED OPS, and that distinction is load-bearing. Every
 * backend requires ops whose colours have been through `render_gpu/ir.js`'s
 * `parsePaint` (the PDF and SVG writers index colour arrays; a raw "#c0392b"
 * silently produces an op that draws NOTHING — measured: the first cut of this
 * module emitted exactly such a box and the contained item vanished instead of
 * turning red, which is the silent failure the affordance exists to prevent).
 * core/ may not import render_gpu, so the shape lives here and each caller
 * builds it with `rect()`/`text()` — one line each, and the validation runs.
 *
 * The caller also decides the FRAME. Every throw-time caller draws at IDENTITY
 * when the node's own transform is unusable — the ba25b39 lesson: that transform
 * may be exactly the poison, so composing through it inside the recovery would
 * rethrow.
 *
 * @param {number} w - box width in local units (pass through errorBoxExtent)
 * @param {number} h - box height in local units
 * @param {string} message - the human-readable failure, drawn inside the box
 * @returns {{rect: object, text: object}} argument objects for ir.rect / ir.text
 *
 * @example // the colours come out PARSED, which is the whole point (see the palette above)
 * errorAffordanceArgs(200, 100, "boom").rect.fill === ERROR_BG
 * true
 * @example errorAffordanceArgs(200, 100, "boom").text.text
 * 'boom'
 * @example // the fallback box is square and visible, never 0-sized:
 * errorAffordanceArgs(errorBoxExtent(NaN), errorBoxExtent(NaN), "boom").rect.w
 * 160
 * @example // the label always fits inside its own box
 * errorAffordanceArgs(200, 100, "boom").text.boxW
 * 184
 */
export function errorAffordanceArgs(w, h, message) {
  return {
    rect: { x: 0, y: 0, w, h, cornerRadius: 0, fill: ERROR_BG, stroke: ERROR_BORDER, strokeWidth: ERROR_BORDER_WIDTH },
    text: {
      text: message,
      x: ERROR_PADDING,
      y: ERROR_PADDING,
      size: Math.max(1, h * ERROR_TEXT_FRACTION),
      color: ERROR_TEXT,
      boxW: Math.max(1, w - 2 * ERROR_PADDING),
      boxH: Math.max(1, h - 2 * ERROR_PADDING),
    },
  };
}

/**
 * Pure function. THE ERROR AFFORDANCE as finished ops, for the ONE caller that
 * cannot reach the IR builders: core/plugin_assets.js, which lives in core/ and
 * may not import render_gpu (the layering rule).
 *
 * Safe precisely because the palette above is already in `parseColor`'s output
 * form, so these ops are indistinguishable from builder-made ones — the property
 * `tests/paint_containment_test.js` pins directly against `parseColor`, so a
 * drift in either place fails the gate rather than producing an invisible box.
 * Every render_gpu caller uses `errorAffordanceArgs` + `rect()`/`text()` instead,
 * to get the builders' validation.
 *
 * @param {number} w - box width in local units
 * @param {number} h - box height in local units
 * @param {string} message - the human-readable failure
 * @returns {object[]} a rect op + a text op, ready for any backend
 *
 * @example errorAffordanceIR(200, 100, "plugin error: no ear found").map((o) => o.op)
 * [ 'rect', 'text' ]
 * @example errorAffordanceIR(200, 100, "boom")[1].text
 * 'boom'
 * @example // the colours are PARSED, never hex — a string here draws nothing
 * Array.isArray(errorAffordanceIR(10, 10, "boom")[0].stroke)
 * true
 */
export function errorAffordanceIR(w, h, message) {
  const a = errorAffordanceArgs(w, h, message);
  return [{ op: "rect", ...a.rect }, { op: "text", ...a.text }];
}

/**
 * Pure function. The message text an error box carries: who broke, and how.
 *
 * @param {string} who - the item's name, type or id (whichever is knowable)
 * @param {string} what - the failure ("emit threw", "unknown material", …)
 * @returns {string}
 *
 * @example errorMessage("Title", "x/y is not a finite number")
 * '"Title": x/y is not a finite number'
 */
export function errorMessage(who, what) {
  return `"${who}": ${what}`;
}

/**
 * Pure function. A throw's message, however it was thrown — Error, string, or
 * some plugin's bare object. Never returns "" (an empty red box would name
 * nothing, which is the silent failure again).
 *
 * @param {*} e - whatever reached the catch
 * @returns {string}
 *
 * @example throwMessage(new Error("unknown material \"crt\""))
 * 'unknown material "crt"'
 * @example throwMessage("plain string throw")
 * 'plain string throw'
 * @example throwMessage(null)
 * 'unknown error'
 */
export function throwMessage(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg && msg !== "null" && msg !== "undefined" ? msg : "unknown error";
}

/**
 * Pure function. The index one past the last flattened op sharing
 * `flat[start]`'s owner — the extent of ONE derived node's contribution to a
 * flattened display list, and therefore THE UNIT every backend's containment
 * boundary wraps.
 *
 * Runs are CONTIGUOUS because render_gpu/ports.js emits one node's ops between
 * its own push and pop and never interleaves two nodes. A folded group member is
 * emitted INSIDE its group's run and inherits the group's owner, which is the
 * right answer: the group is the thing the user can select and delete, so the
 * group is the thing the report should name.
 *
 * @param {object[]} flat - flattenIR output ([{cmd, world, owner}])
 * @param {number} start - index of the run's first op
 * @returns {number} the exclusive end index (always > start)
 *
 * @example ownerRunEnd([{owner: {itemId: "a"}}, {owner: {itemId: "a"}}, {owner: {itemId: "b"}}], 0)
 * 2
 * @example ownerRunEnd([{owner: {itemId: "a"}}, {owner: {itemId: "b"}}], 1)
 * 2
 * @example // untagged ops (a hand-assembled background) form one run of their own
 * ownerRunEnd([{owner: null}, {owner: null}], 0)
 * 2
 */
export function ownerRunEnd(flat, start) {
  const id = flat[start].owner?.itemId ?? null;
  let i = start + 1;
  while (i < flat.length && (flat[i].owner?.itemId ?? null) === id) i++;
  return i;
}

/**
 * Pure function. A local-space box for a failed run's error affordance, taken
 * from the first op in the run that declares a usable extent — so the box lands
 * roughly where the widget was, at roughly its size, instead of at an arbitrary
 * default.
 *
 * @param {object[]} flat - flattenIR output
 * @param {number} start - run start (inclusive)
 * @param {number} end - run end (exclusive)
 * @returns {{w: number, h: number}}
 *
 * @example containmentBoxSize([{cmd: {op: "rect", w: 300, h: 120}}], 0, 1)
 * { w: 300, h: 120 }
 * @example // no op declares an extent (a path, a polyline): the visible fallback
 * containmentBoxSize([{cmd: {op: "path", d: "M0 0"}}], 0, 1)
 * { w: 160, h: 160 }
 * @example // a poisoned w is refused the same way a missing one is
 * containmentBoxSize([{cmd: {op: "rect", w: NaN, h: 40}}], 0, 1)
 * { w: 160, h: 160 }
 */
export function containmentBoxSize(flat, start, end) {
  for (let i = start; i < end; i++) {
    const { w, h } = flat[i].cmd;
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { w, h };
  }
  return { w: ERROR_FALLBACK_SIZE, h: ERROR_FALLBACK_SIZE };
}

/**
 * Pure function. The name to blame in a report and on the box, preferring the
 * most human of what the node knows.
 *
 * @param {object|null} node - a render node or op owner ({itemId, type, state})
 * @returns {string}
 *
 * @example describeOwner({itemId: "cf17cc12", type: "text", state: {name: "Title"}})
 * 'Title'
 * @example describeOwner({itemId: "cf17cc12", type: "text"})
 * 'text cf17cc12'
 * @example describeOwner(null)
 * 'unknown item'
 */
export function describeOwner(node) {
  if (!node) return "unknown item";
  const name = node.state?.name || node.name;
  if (name) return String(name);
  const type = node.state?.type || node.type;
  const id = node.itemId;
  if (type && id) return `${type} ${id}`;
  return String(type || id || "unknown item");
}
