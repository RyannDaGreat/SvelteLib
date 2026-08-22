/**
 * web/html2imageAutoRender.js — THE AUTOMATIC RE-RENDER SERVICE for the HTML to
 * Image widget: it watches the document, and whenever a widget's stored picture
 * stops matching its stored HTML it renders a new one. No button, ever, in the
 * normal flow.
 *
 * ── THE RULING ──────────────────────────────────────────────────────────────
 * User, 2026-08-13: *"i don't want to have to press capture. it should be automatic
 * in every way, when the html property changes so shohuld that."* — amending his
 * first, blunter verdict on the placeholder card: *"wtf is this bullcrap? where's the
 * rendering? what the fuq do u mean press capture? that sounds like ephemeral
 * state?"*
 *
 * core/html2image_staleness.js owns WHAT stale means (a fingerprint of the html and
 * the two render dimensions, stored beside the asset ref) and answers the
 * determinism accusation in full. This file owns WHEN and HOW OFTEN, which is
 * entirely a scheduling problem, and a nastier one than it looks:
 *
 *   A RENDER WRITES THE DOCUMENT. THE WATCHER READS THE DOCUMENT.
 *
 * Everything below is shaped by that loop. Get it wrong and the app either renders
 * forever or renders nothing.
 *
 * ── WHY THIS IS NOT AN `$effect` ────────────────────────────────────────────
 * The obvious implementation — an `$effect` that reads `app.state()` and starts a
 * render — is the one thing that cannot work here, and web/App.svelte already
 * carries the scar tissue explaining why: *"read+write of one state in one effect is
 * effect_update_depth_exceeded"*. The render's commit writes `doc`, `doc` is the
 * `$state` the read subscribed to, and Svelte tears the app down.
 *
 * So the watcher is a PLAIN SUBSCRIPTION driven by an explicit `notify()` the app
 * calls after a commit, and the scan runs OUTSIDE any reactive context. The service
 * holds no Svelte state at all — its queue is ordinary fields on an ordinary object.
 * That also makes it testable in bare node with a stub app, which is what
 * tests/html2image_autorender_test.js does.
 *
 * ── THE FINGERPRINT IS WHAT TERMINATES THE LOOP ─────────────────────────────
 * This is the load-bearing sentence of the whole feature. A render writes TWO leaves
 * as one commit: the new asset ref AND the fingerprint of the source it was rendered
 * from. The watcher then re-scans (its own write woke it), finds the widget FRESH,
 * and stops. If the fingerprint write were ever dropped, split into a second commit,
 * or computed from different inputs than the staleness check reads, the widget would
 * be stale again immediately and the app would render in an infinite loop — burning
 * an asset file per iteration. That is why `sourceFingerprint` is called ONCE, on the
 * state the render actually used, and carried through with the result rather than
 * recomputed at commit time from a state that may have moved on.
 *
 * ── DEBOUNCE, THEN SERIALIZE — TWO DIFFERENT PROBLEMS ───────────────────────
 * DEBOUNCE (per widget, RENDER_DEBOUNCE_MS) answers "the author is still typing".
 * Every keystroke in the Monaco modal that commits, every drag of the Render width
 * spinner, is a document change; rendering each would mint an asset per keystroke.
 * The timer restarts on each change, so a burst of edits produces ONE render.
 *
 * SERIALIZE (per widget) answers "the source changed while a render was in flight".
 * A render is async and slow (a real page layout plus a rasterize). Overlapping two
 * of them for one widget races two commits at the same leaf, and the loser silently
 * wins — the widget ends up showing whichever finished LAST rather than the newest
 * source. So a widget with a render in flight records ONE pending re-run, and
 * coalesces any further changes into it: an edit during a render queues exactly one
 * more, never a stack of them. That is the brief's requirement and it falls out of
 * `pending` being a boolean rather than a list.
 *
 * ── EQUATION-DRIVEN HTML: THE BOUND, STATED HONESTLY ────────────────────────
 * `html` is an ordinary property, so it may be bound to an `=` equation — including
 * one reading `time`. This service watches the EVALUATED value, so such a widget is
 * stale on every tick that changes its html, and the debounce is what makes that
 * survivable: it renders at SETTLE, not per frame. An html bound to a continuously
 * varying value therefore renders repeatedly and mints an asset each time, and it
 * will never be "caught up" — the picture always trails the source by the debounce
 * plus the render time.
 *
 * THAT IS A REAL LIMITATION AND IT IS NOT PAPERED OVER. It is also not a new one:
 * the same author could always have held Capture down. What this service adds is
 * that it happens without being asked, so a deck built that way accumulates assets
 * quietly. The honest fix is a widget-level opt-out, which is NOT built (a knob
 * whose only purpose is to disable the feature the user just demanded is the wrong
 * first move). The mitigation that IS built: an animated html is a pathological
 * authoring choice, not something any preset or default produces, and the debounce
 * bounds the rate to at most one render per RENDER_DEBOUNCE_MS + render duration.
 *
 * ── UNDO REUSES THE OLD PICTURE, FOR FREE ───────────────────────────────────
 * Undoing an html edit restores the PREVIOUS html, capture ref AND fingerprint
 * together — they were written in one commit, so undo reverts them as one. The
 * restored fingerprint matches the restored html, the widget scans FRESH, and no
 * render fires. So undo is instant and reuses the old asset with no cache, no
 * bookkeeping and no special case anywhere in this file. That is the cheap win the
 * fingerprint design pays out, and it is the reason the fingerprint lives in the
 * DOCUMENT rather than in a side table in this service: a side table would not be
 * undone with it.
 *
 * ── WHAT THIS SERVICE NEVER DOES ────────────────────────────────────────────
 * It does not run during PLAYBACK, EXPORT or in the CLI. It is a `web/` module the
 * editor shell starts; nothing in the render path imports it. Playback reads the
 * stored asset and never the html — see core/html2image_staleness.js's determinism
 * note, which is the answer to the user's "ephemeral state?".
 */

import { CAPTURE_OF_KEY, sourceFingerprint, staleCaptureIds } from "../core/html2image_staleness.js";
import { html2imagePlugin } from "../plugins/html2image.js";

/**
 * How long a widget must stop changing before it renders. Long enough to swallow a
 * burst of typing or a spinner drag; short enough that a deliberate edit feels
 * immediate. This is the ONLY thing standing between a per-keystroke commit and a
 * per-keystroke asset file, so it is a named constant rather than a literal.
 */
export const RENDER_DEBOUNCE_MS = 400;

/**
 * The service. ONE per app, created by the editor shell (web/App.svelte) and given
 * the app to read and write.
 *
 * A CLASS AND NOT MODULE-LEVEL STATE, because the probes and the bare-node test each
 * want their own instance with their own stub app — module state would leak a queue
 * between them and make the tests order-dependent.
 */
export class Html2ImageAutoRender {
  /** The app store (read `state()`, write through setPreview/commitPreview). */
  #app;
  /** itemId → debounce timer handle, for widgets whose source is still settling. */
  #timers = new Map();
  /** itemId → true while a render is in flight for it (the serialize half). */
  #running = new Set();
  /** itemId → true when a change arrived DURING a render (the coalesced re-run). */
  #pending = new Set();
  /**
   * itemId → the fingerprint whose render FAILED, so it is never retried.
   *
   * THIS FIELD EXISTS BECAUSE THE TEST CAUGHT ITS ABSENCE, and the mechanism is worth
   * stating: a failed render writes NOTHING, so the widget stays stale — and staleness
   * is exactly what the watcher scans for. Without this set, every subsequent
   * `notify()` (i.e. every commit anywhere in the document, including ones that have
   * nothing to do with this widget) re-attempts a source that cannot succeed, once per
   * debounce, forever, with a console line each time. The first version of this file
   * claimed in its own comment that failures are "NOT RETRIED" while doing precisely
   * that; tests/html2image_autorender_test.js measured 2 attempts where it asserted 1.
   *
   * KEYED BY FINGERPRINT AND NOT BY ID, which is what re-arms it automatically: the
   * author edits the broken source, the fingerprint changes, the stored failure no
   * longer matches and the widget renders again. So there is no "clear the error"
   * affordance to forget to call, and no way for a fixed source to stay suppressed.
   */
  #failed = new Map();
  /** How many renders this service has completed — probes and tests assert on it,
   * and it is how "exactly one render for a burst of edits" is measured. */
  renderCount = 0;
  /** The last failure, as `{itemId, message}`, or null. Kept so the widget's own
   * copy can say what went wrong; a failure is ALSO reported to the console, because
   * a silent failure here would leave a widget showing an old picture forever. */
  lastError = null;
  /** Injected renderer — `(app, {html, width, height}) => Promise<ref>`. Defaults to
   * the real capture pipeline, LAZILY imported (web/html2image.js touches `document`,
   * so a static import would break bare node). The seam exists so the node test can
   * drive the whole scheduler with a synchronous fake and assert on debounce and
   * serialization without a browser. */
  #render;

  /**
   * @param {object} app - the editor app store
   * @param {object} [opts] - `{render}` to override the renderer (tests)
   */
  constructor(app, opts = {}) {
    this.#app = app;
    this.#render = opts.render ?? (async (a, req) => {
      const { captureHtmlToAsset } = await import("./html2image.js");
      return captureHtmlToAsset(a, req);
    });
  }

  /**
   * Command. THE ENTRY POINT: "the document may have changed — look for stale
   * pictures." Cheap and idempotent, so the app may call it after every commit
   * without thinking about it.
   *
   * IT SCHEDULES, IT DOES NOT RENDER. Everything it touches is a timer, which is what
   * keeps it callable from inside a reactive context: it performs no write, so it
   * cannot re-enter the effect that called it.
   */
  notify() {
    for (const id of staleCaptureIds(this.#app.state(), html2imagePlugin.type)) this.#schedule(id);
  }

  /** Command. Debounces one widget: a change restarts its timer, so a burst settles
   * into a single render. */
  #schedule(id) {
    clearTimeout(this.#timers.get(id));
    this.#timers.set(id, setTimeout(() => {
      this.#timers.delete(id);
      this.#run(id);
    }, RENDER_DEBOUNCE_MS));
  }

  /**
   * Command (async). Renders ONE widget, if it is still stale and not already
   * rendering.
   *
   * THE RE-CHECK AT THE TOP IS NOT REDUNDANT with notify()'s: the debounce means
   * RENDER_DEBOUNCE_MS passed since the scan that scheduled this, and in that window
   * an undo may have restored a matching fingerprint or the item may have been
   * deleted. Rendering a widget that is no longer stale would write an asset nobody
   * asked for and, worse, restart the loop.
   */
  async #run(id) {
    if (this.#running.has(id)) { this.#pending.add(id); return; }
    const state = this.#app.state().items?.[id];
    if (!state || state.type !== html2imagePlugin.type) return;
    if (!staleCaptureIds({ items: { [id]: state } }, html2imagePlugin.type).length) return;

    // THE FINGERPRINT IS TAKEN FROM THE STATE BEING RENDERED, before any await, and
    // carried to the commit. Recomputing it after the render would fingerprint a
    // source that may have changed meanwhile — the widget would then look fresh while
    // showing the OLDER picture, which is the one wrong answer that is also silent.
    const fingerprint = sourceFingerprint(state);
    // A source that already failed at THIS exact fingerprint is not retried — see
    // `#failed`. Editing it changes the fingerprint and re-arms the render.
    if (this.#failed.get(id) === fingerprint) return;
    const request = {
      html: state.html ?? "",
      width: state.captureW,
      height: state.captureH,
    };
    this.#running.add(id);
    try {
      const ref = await this.#render(this.#app, request);
      // ONE COMMIT, TWO LEAVES — see this module's header: the picture and the
      // provenance of the picture must land together or the loop never terminates.
      this.#app.setPreview([
        [["items", id, "capture"], ref],
        [["items", id, CAPTURE_OF_KEY], fingerprint],
      ]);
      this.#app.commitPreview();
      this.renderCount++;
      this.#failed.delete(id);
      this.lastError = null;
    } catch (err) {
      // LOUD. The message is the capture pipeline's own sentence (a foreign
      // subresource by URL, a script that threw, a timeout), which is why it is
      // surfaced verbatim rather than summarised.
      const message = String(err?.message ?? err);
      this.#failed.set(id, fingerprint);
      this.lastError = { itemId: id, message };
      console.error(`HTML to Image: automatic render failed — ${message}`);
      // NOT RETRIED — enforced by `#failed` above, not merely intended. The source is
      // broken until the author changes it, and re-attempting it once per debounce
      // forever is what this recorded fingerprint prevents.
    } finally {
      this.#running.delete(id);
      if (this.#pending.delete(id)) this.#schedule(id);
    }
  }

  /** Query. Is a render in flight for this widget? The widget's own copy reads it to
   * say "Rendering…" rather than "not rendered yet", so an in-progress render never
   * looks like a failure. */
  isRendering(id) {
    return this.#running.has(id);
  }

  /** Command. Cancels every pending timer — the editor shell's teardown. Leaves
   * in-flight renders to finish (their commits are harmless; they write the document
   * the next session will load). */
  dispose() {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }
}
