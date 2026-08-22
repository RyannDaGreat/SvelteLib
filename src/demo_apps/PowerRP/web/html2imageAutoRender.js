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
 * ── THE SCAN IS THE WHOLE DOCUMENT, NOT THE SLIDE ON SCREEN ─────────────────
 * R7-43a's rule is that staleness is a property of the DOCUMENT, and `app.state()`
 * is ONE SLIDE'S answer to it. Scanning only that was a hole with no error in it: a
 * widget whose `html` is keyframed on slide 2 is simply absent from slide 1's state,
 * so it rendered on NEITHER — the boot scan looked at slide 1, and `set slideIndex`
 * wakes no document watcher, so arriving at slide 2 never re-asked. Such a deck
 * presented and exported the PLACEHOLDER CARD forever. So `#slideStates` folds and
 * evaluates every slide, and the render's keyframe is written on THE SLIDE ITS
 * SOURCE LIVES ON.
 *
 * EARLIEST STALE SLIDE WINS, AND THAT IS WHAT KEEPS IT TO ONE RENDER. A widget
 * inserted on slide 0 is stale on all N slides at once (the fold carries it
 * forward); scheduling each would mint N assets for one picture. `#staleTargets`
 * therefore keeps only the FIRST slide each id is stale on, so the write lands at
 * the boundary where the source actually changed and the fold makes every later
 * slide fresh. A source that genuinely differs on slide 5 is still stale there after
 * that write, and the next scan renders it there — the walk converges from the front.
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
 * ── UNDO FIGHTS THIS SERVICE, AND THE DEFECT IS OPEN ────────────────────────
 * THIS PARAGRAPH USED TO CLAIM THE OPPOSITE — "UNDO REUSES THE OLD PICTURE, FOR
 * FREE … they were written in one commit, so undo reverts them as one" — and no code
 * path has ever produced that commit. The html edit is the USER'S undo entry; the
 * render is a SEPARATE `app.commit` some hundreds of milliseconds later. So undoing
 * an html edit pops the RENDER's entry and restores {new html, OLD picture, OLD
 * fingerprint}: stale by construction. The watcher then re-renders, mints another
 * asset, and that commit CLEARS `future` — so Redo dies, the next Ctrl-Z pops the
 * asset it just made, and a slow series of undos never reaches the pre-edit source at
 * all. MEASURED against the real core/undo.js and this class: five undos produced
 * shot3…shot7.png with the html never leaving `<p>EDITED</p>`. Only undos issued
 * INSIDE the debounce window get back.
 *
 * IT IS NOT FIXABLE IN THIS FILE, and that is why it is written down rather than
 * worked around. The render's write must stop being its own undo transaction — either
 * an `amend(doc)` on core/undo.js that replaces `present` without pushing or clearing
 * `future`, or a non-undoable write seam on web/app.svelte.js (set `doc` + autosave +
 * wake the watchers, skipping `undoLog.commit`). The fingerprint already guarantees a
 * re-render for whatever state an undo restores, so neither costs correctness.
 * `#writeCapture` below is the ONE place that would change.
 *
 * ── WHAT THIS SERVICE NEVER DOES ────────────────────────────────────────────
 * It does not run during PLAYBACK, EXPORT or in the CLI. It is a `web/` module the
 * editor shell starts; nothing in the render path imports it. Playback reads the
 * stored asset and never the html — see core/html2image_staleness.js's determinism
 * note, which is the answer to the user's "ephemeral state?".
 */

import { CAPTURE_OF_KEY, sourceFingerprint, staleCaptureIds } from "../core/html2image_staleness.js";
import { foldState, keyframed } from "../core/document.js";
import { evaluateState } from "../core/expressions.js";
import { html2imagePlugin } from "../plugins/html2image.js";

/**
 * How long a widget must stop changing before it renders. Long enough to swallow a
 * burst of typing or a spinner drag; short enough that a deliberate edit feels
 * immediate. This is the ONLY thing standing between a per-keystroke commit and a
 * per-keystroke asset file, so it is a named constant rather than a literal.
 */
export const RENDER_DEBOUNCE_MS = 400;

/**
 * Pure function. Does this document ever DECLARE an item of `type`?
 *
 * THE CHEAP GATE IN FRONT OF THE ALL-SLIDES SCAN, and the reason a deck with no
 * HTML-to-Image widget pays almost nothing for the walk described in this module's
 * header. An item's `type` is written exactly once, into the delta of the slide that
 * creates it (core/document.js drops a typeless item in the repair pipeline), so a
 * raw walk of the deltas answers this EXACTLY — no folding, no evaluation, no
 * heuristic — in one pass over the stored keyframes.
 *
 * @param {object} doc - a PowerRP document
 * @param {string} type - the plugin type string to look for
 * @returns {boolean}
 *
 * @example documentHasType({ slides: [{ delta: { items: { a: { type: "rect" } } } }] }, "html2image")
 * false
 * @example // declared on a LATER slide — the case the current-slide scan used to miss:
 * documentHasType({ slides: [{ delta: {} }, { delta: { items: { w: { type: "html2image", html: "<p>hi</p>" } } } }] }, "html2image")
 * true
 * @example documentHasType({ slides: [] }, "html2image")
 * false
 */
export function documentHasType(doc, type) {
  return (doc?.slides ?? []).some(
    (slide) => Object.values(slide?.delta?.items ?? {}).some((d) => d?.type === type),
  );
}

/**
 * The service. ONE per app, created by the editor shell (web/App.svelte) and given
 * the app to read and write.
 *
 * A CLASS AND NOT MODULE-LEVEL STATE, because the probes and the bare-node test each
 * want their own instance with their own stub app — module state would leak a queue
 * between them and make the tests order-dependent.
 *
 * ── THE TWO APP SHAPES THIS SERVICE ACCEPTS ─────────────────────────────────
 * The editor app carries a DOCUMENT (`app.doc`), and the scan folds every slide of
 * it. tests/html2image_autorender_test.js drives the scheduler with a stub that is a
 * plain items map and NO document, because debounce and serialization are not about
 * slides. That is a stated part of this class's interface, not a fallback hiding a
 * failure: an app with no document has no slide to name, so its `state()` IS the
 * document and the walk below is the same walk over a one-slide deck. Exactly TWO
 * methods decide it — `#evaluationInputs` (which reads) and `#writeCapture` (which
 * writes) — and everything else is shape-blind.
 */
export class Html2ImageAutoRender {
  /** The app store (read the document, write through #writeCapture). */
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
  /** The last failure, as `{itemId, message}`, or null. Kept so a probe can report
   * what went wrong; a failure is ALSO reported to the console, because a silent
   * failure here would leave a widget showing an old picture forever. */
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
   * Query. THE FOUR INPUTS `evaluateState` needs beyond the fold, taken from the app
   * ONCE so a walk over N slides asks for them once rather than N times — and, more
   * importantly, so it passes exactly what the canvas passes. `evaluateState`
   * memoizes on state identity PLUS these four compared by reference, so on the
   * ordinary deck the current slide's evaluation is a memo HIT on the pass the editor
   * already ran; supplying anything else here would silently double the editor's
   * evaluation work on every commit. (The state identity has its own condition —
   * "THE MEMO HIT IS ON THE FOLD" below; do not read this sentence without it.)
   *
   * ALL FOUR OR NONE, AND `varKinds` IS THE ONE THAT PROVES IT. The list started as
   * THREE — registry, script, content sizes — and dropping the fourth was not a
   * partial win but the whole loss, MEASURED: `repairedDocument` writes
   * `meta.varKinds` into EVERY document (an empty `{}` when the deck declares no
   * kinds), the memo compares it by reference, and `{} === null` is false — so the
   * three-input version missed the memo on EVERY document that exists, and worse,
   * OVERWROTE the editor's entry with its own null-keyed one, making the editor's
   * next `state()` miss too. That is precisely the doubling the paragraph above
   * promises to avoid, arriving through the one input the paragraph forgot. It is
   * also a semantic difference and not only a cost: with no kind map every variable
   * declares "number" (core/var_kinds.js's `varKind`, "absent entries ARE number"), so
   * a colour or string variable would be rendered from a DIFFERENT value than the
   * canvas shows.
   *
   * `varKindsForEval()` is read rather than `doc.meta.varKinds`, because that method
   * exists to hand out the RAW map — never a fresh `?? {}` — for exactly this memo.
   *
   * THE MEMO HIT IS ON THE FOLD, SO IT IS THE COMMON DECK AND NOT EVERY DECK. The
   * scan folds with `foldState`, while `app.rawState()` additionally applies the
   * slide's TRIGGER writes (core/exec_flow.withExecOverlay) and any staged PREVIEW
   * delta. A deck with exec wires, or a moment mid-drag, therefore hands
   * `evaluateState` a different fold and pays one evaluation — which is also the
   * conservative answer for the preview: a picture must be rendered from what the
   * document SAYS, not from a gesture the author has not committed.
   *
   * THE CONTENT-SIZE TABLE IS THE APP'S ONE TABLE, not a per-slide copy: it is
   * identity-stable (web/contentSizes.js caches on a signature) and minting a fresh
   * one per slide would miss that memo every time. It can only differ for a widget
   * whose html is bound to `self.content.*`, which no preset or default produces.
   *
   * `null` for a DOCUMENT-LESS APP, which has no slides to evaluate — see this
   * class's docblock. This is the ONE place that shape is decided.
   */
  #evaluationInputs() {
    const app = this.#app;
    if (!app.doc) return null;
    return {
      registry: app.registry,
      script: app.projectScript(),
      contentSizes: app.contentSizes(),
      varKinds: app.varKindsForEval(),
    };
  }

  /** Query. The evaluated state at one slide (alpha 1 — a scan asks about settled
   * slides, never about a transition's midpoint). `inputs` comes from
   * `#evaluationInputs`; `null` means the one-slide app, whose `state()` IS the
   * answer. */
  #evaluatedAt(slide, inputs) {
    if (!inputs) return this.#app.state();
    const { registry, script, contentSizes, varKinds } = inputs;
    return evaluateState(foldState(this.#app.doc, slide, 1), registry, script, contentSizes, varKinds).state;
  }

  /** Query. Every `[slideIndex, evaluated state]` pair the scan must examine, in
   * slide order. One pair for a document-less app; one per slide otherwise. */
  #slideStates() {
    const inputs = this.#evaluationInputs();
    const count = inputs ? this.#app.doc.slides.length : 1;
    return Array.from({ length: count }, (_, i) => [i, this.#evaluatedAt(i, inputs)]);
  }

  /**
   * Query. `itemId → {slide, state}` for every stale widget in the document, keyed to
   * the EARLIEST slide it is stale on (this module's header states why that, and only
   * that, is the slide to write on).
   *
   * The `documentHasType` gate in front means a deck with no such widget — the
   * overwhelming majority — never folds or evaluates a single slide here.
   */
  #staleTargets() {
    const targets = new Map();
    const type = html2imagePlugin.type;
    if (this.#app.doc && !documentHasType(this.#app.doc, type)) return targets;
    for (const [slide, state] of this.#slideStates()) {
      for (const id of staleCaptureIds(state, type)) {
        if (!targets.has(id)) targets.set(id, { slide, state: state.items[id] });
      }
    }
    return targets;
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
    for (const id of this.#staleTargets().keys()) this.#schedule(id);
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
   * Command. Writes the render's two leaves as ONE commit, keyframed on `slide`.
   *
   * NOT setPreview + commitPreview, for two reasons that both bite:
   *   - commitPreview keyframes on the app's CURRENT slide, which is the wrong slide
   *     whenever the stale source lives on another one — the picture would land on a
   *     slide whose html it is not a picture of, and the real one would stay stale.
   *   - setPreview REPLACES the app's staged preview delta wholesale, so a render
   *     landing mid-drag threw the drag away.
   * ONE `commit` for BOTH leaves — see this module's header: the picture and the
   * provenance of the picture must land together or the loop never terminates. (This
   * is also the one place the open UNDO defect above would be fixed.)
   *
   * A DOCUMENT-LESS APP IS ONE SLIDE — see this class's docblock.
   */
  #writeCapture(slide, id, ref, fingerprint) {
    const app = this.#app;
    const leaves = [[["items", id, "capture"], ref], [["items", id, CAPTURE_OF_KEY], fingerprint]];
    if (!app.doc) {
      app.setPreview(leaves);
      app.commitPreview();
      return;
    }
    let doc = app.doc;
    for (const [path, value] of leaves) doc = keyframed(doc, slide, path, value);
    app.commit(doc);
  }

  /**
   * Command (async). Renders ONE widget, if it is still stale and not already
   * rendering.
   *
   * THE RE-SCAN AT THE TOP IS NOT REDUNDANT with notify()'s: the debounce means
   * RENDER_DEBOUNCE_MS passed since the scan that scheduled this, and in that window
   * an undo may have restored a matching fingerprint, the item may have been deleted,
   * or the source may have moved to a different slide. Rendering a widget that is no
   * longer stale would write an asset nobody asked for and, worse, restart the loop.
   */
  async #run(id) {
    if (this.#running.has(id)) { this.#pending.add(id); return; }
    const target = this.#staleTargets().get(id);
    if (!target) return; // gone, or made fresh, during the debounce window
    const { slide, state } = target;

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
      // THE ITEM MAY HAVE BEEN PURGED WHILE THE RENDER WAS IN FLIGHT, and committing
      // then wrote a TYPELESS ZOMBIE — a slide delta holding {capture, captureOf} for
      // an id with no `type`, which deriveRenderTree tolerates and the NEXT load
      // reports as `dropped item "w" — no type is ever set (orphaned keyframes)` on a
      // deck the author never hand-edited. The existence check before the await cannot
      // answer this; only a re-read after it can. Reported rather than silent: the
      // rendered asset is now an orphan in the library and nobody else will say so.
      const after = this.#stateOf(slide, id);
      if (!after || after.type !== html2imagePlugin.type) {
        console.warn(`HTML to Image: "${id}" was removed while its render was in flight — discarding the picture (asset ${ref} is now unreferenced).`);
        return;
      }
      this.#writeCapture(slide, id, ref, fingerprint);
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

  /** Query. One item's evaluated state on one slide, or undefined when the item does
   * not exist there. The narrow read `#run` needs after its await — a full
   * `#staleTargets()` would answer a different question (the item is still stale, of
   * course: the write has not landed yet). */
  #stateOf(slide, id) {
    return this.#evaluatedAt(slide, this.#evaluationInputs())?.items?.[id];
  }

  /** Query. Is a render in flight for this widget? A PROBE AND TEST HOOK ONLY —
   * nothing in the app reads it. (This docblock used to promise that "the widget's own
   * copy reads it to say Rendering…"; emit() has exactly two branches, image or
   * placeholder, and no "Rendering…" state exists anywhere in the codebase.) */
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
