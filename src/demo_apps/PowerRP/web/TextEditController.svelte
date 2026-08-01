<!--
  TextEditController — TRUE in-place rich-text editing where the caret + selection
  are drawn from the SAME CanvasKit Paragraph that RENDERS the glyphs, so they are
  correct across mixed size/bold/font runs by construction (the fix for the old
  transparent-contenteditable overlay, whose BROWSER-laid-out caret drifted from
  the Skia glyphs — worst on mixed runs).

  ARCHITECTURE (the Figma / Google Slides / Monaco / CodeMirror model):
    • The MODEL (core/richtext.js {runs,paras}) is the source of truth; the
      selection lives here as MODEL character offsets {anchor, focus} — NOT a DOM
      Selection. Edits go through the pure primitives insertText/deleteRange/
      applyRunStyle/applyParaStyle and app.previewTextValue (one undo unit on
      commit — unchanged from the old overlay).
    • The model is derived TWICE, and mixing the two is a bug: `rich`
      (unresolvedRichText) is the STORABLE value every edit starts from and stages,
      `resolved` (normalizeRichText) is what the layout draws and the toolbar
      displays. Editing the resolved value re-materializes run keys the user never
      set and RE-SHADOWS the box-level Inspector rows (see the derivation below).
    • GEOMETRY comes from render_gpu/skia/text_layout.getTextLayout — the EXACT
      Paragraph stack paint_skia.drawTextOp draws — so caret/selection are aligned
      to the visible glyphs. We author ZERO text metrics.
    • The caret + selection are SELF-DRAWN (DOM divs) in the item's LOCAL space,
      inside a root transformed by the item's world pose (rotation + scale) → they
      inherit the exact world→screen mapping and land on the glyphs at any zoom.
    • A HIDDEN contenteditable "sink" at the caret owns keystrokes, IME
      composition, and clipboard (a pure event source — its layout is never read).
      On compositionupdate we mirror the composing string into the model as a
      PROVISIONAL run so the composing glyphs render in Skia at the caret (WYSIWYG);
      compositionend commits it.

  DROPPED (deliberate, documented): native browser spellcheck. Skia draws the
  glyphs; the browser has no visible text under the transparent sink to underline —
  the same trade-off every canvas/self-drawn editor (Figma/Slides/Monaco/CM6)
  makes. V2 could add a JS dictionary + self-drawn squiggles (getWordBoundary +
  selectionRects). Per-run OUTLINE is still not painted live (a pre-existing
  Paragraph-path gap, not introduced here); the toolbar still reflects it.

  Styling lives in app.css (.text-edit-*; app convention: no <style>). The root
  keeps the `.text-edit-overlay-root` class so App.svelte's click-away dismissal
  (`.closest(".text-edit-overlay-root")`) and the toolbar-focus guard still work.
-->
<script>
  import * as T from "../core/transform.js";
  import { DEFAULT_FONT } from "../render_gpu/fonts.js";
  import { getTextLayout } from "../render_gpu/skia/text_layout.js";
  import {
    normalizeRichText, unresolvedRichText, richTextToPlain, runsLength, runStyleAt,
    commonStyle, applyRunStyle, adjustRunSize, steppedSize, applyParaStyle, insertText, deleteRange,
    DEFAULT_PARA_SIZE, SIZE_STEP,
  } from "../core/richtext.js";
  import TextFormatToolbar from "./TextFormatToolbar.svelte";

  // app = the app store; node = the edited item's derived render node (preview-
  // blended, so live edits reflect as you type); gpu = the shared SkiaSurface
  // (gpu.CanvasKit + gpu.fontCollection — the SAME instances the render uses);
  // worldToScreen/screenToWorld = the PanZoom camera maps (render-area frame);
  // zoom = viewport.zoom.
  let { app, node, gpu, worldToScreen, screenToWorld, zoom } = $props();

  const CARET_SCREEN_PX = 2; // caret thickness on screen (counter-scaled to LOCAL below)
  // SIZE_STEP (px per Cmd+/-) and DEFAULT_PARA_SIZE (the fallback glyph size for a
  // bare op with no explicit size) are IMPORTED, not re-declared. Both used to be
  // local copies here and in the toolbar, and the pair drifted: the same +1 step on
  // the same mixed selection produced 50 from this file and 38 from that one.

  // PLAIN-STRING mode (a single-string widget like plaintext, routed here through
  // its `inlineTextEdit` descriptor): the widget stores ONE plain string, not a
  // {runs,paras} value, so this controller (a) shows NO format toolbar, (b) makes
  // every run/paragraph STYLE op a no-op (there are no runs to style), and (c)
  // flattens its rich editing model to a plain string at the app boundary
  // (stageValue). All the caret/selection/IME/clipboard/undo machinery is shared
  // verbatim. Rich mode (the text widget) is unchanged: `plain` is false.
  let plain = $derived(!!app.textEditing?.plain);

  // ── selection = MODEL code-point offsets (anchor fixed, focus moving) ─────────
  let anchor = $state(0);
  let focus = $state(0);
  let goalX = $state(null);        // LOCAL x preserved across Up/Down (null = recompute)
  let pendingStyle = $state({});   // caret-style overrides for the NEXT typed char (empty-selection toggles)
  let composing = $state(false);   // an IME composition is in flight
  let compBase = null;             // rich value BEFORE the composing run (non-reactive)
  let compAnchor = 0;              // offset the composing run is inserted at
  let seeded = false;

  let sinkEl = $state(null);       // the hidden contenteditable input sink
  let hitEl = $state(null);        // the transparent pointer hit-surface over the box
  let pdrag = null;                // in-progress selection drag (non-reactive)

  let selStart = $derived(Math.min(anchor, focus));
  let selEnd = $derived(Math.max(anchor, focus));

  // The widget-level fallbacks a legacy/partial value inherits — MUST match the
  // owning plugin's emit() exactly so the editor's layout equals the render's.
  // The ink color reads a DIFFERENT state prop per mode: plaintext paints glyphs
  // with `fill` (its paint-capable ink prop), the rich text widget with `color`.
  let inherited = $derived({
    font: node.state.font ?? DEFAULT_FONT, size: node.state.size ?? DEFAULT_PARA_SIZE,
    color: (plain ? node.state.fill : node.state.color) ?? "#000000", bold: node.state.bold ?? false,
  });

  // TWO VALUES, ONE STORED VALUE — the seam that keeps an edit from RE-SHADOWING
  // the box rows. `rich` is SHAPE-CANONICAL but STYLE-UNRESOLVED: it is what may
  // be WRITTEN BACK, so every mutation below starts from it and a run keeps only
  // the keys the user actually set. `resolved` layers the widget-level fallbacks
  // on top and is what the layout DRAWS and the toolbar DISPLAYS.
  //
  // This controller used to edit the RESOLVED value and stage it verbatim, which
  // re-materialized all ten run keys on the FIRST keystroke (measured: run keys
  // ["text"] → eleven) and killed the four box-level typography rows 437df12 had
  // just freed — font/size/bold/color went byte-identical under renderDocToPng
  // again. A paragraph-align commit did it too (applyParaToSelection writes
  // base.runs verbatim). Resolution is not skipped, only left to the ONE layer
  // that owns it: emit(). core/richtext guarantees
  // normalizeRichText(unresolvedRichText(v), inherited) === normalizeRichText(v,
  // inherited), so nothing about what is drawn changed.
  let rich = $derived(unresolvedRichText(node.state.text));
  let resolved = $derived(normalizeRichText(rich, inherited));

  // ── geometry: the CACHED CanvasKit Paragraph stack the RENDER also draws ──────
  // Built through the ONE getTextLayout path with the SAME cmd the text plugin
  // emits, so caret/selection come from the identical shaped layout as the glyphs.
  let layout = $derived.by(() => {
    if (!gpu) return null;
    const s = node.state;
    // PLAIN mode builds the SAME LEGACY single-run op the plaintext plugin emits
    // (getTextLayout wraps it via singleRunRich) so the caret/selection geometry
    // is byte-identical to the plaintext render; RICH mode passes the {runs,paras}
    // value + full paragraph box style, as before.
    // The layout draws the RESOLVED value: text_layout reads run.size/font/color
    // directly, so the box → run layering must already have happened here.
    const cmd = plain
      ? {
          text: richTextToPlain(resolved),
          size: s.size ?? DEFAULT_PARA_SIZE,
          color: s.fill ?? "#000000",
          bold: s.bold ?? false,
          font: s.font ?? DEFAULT_FONT,
          boxW: (s.w ?? 0) > 0 ? s.w : Infinity,
          boxH: (s.h ?? 0) > 0 ? s.h : Infinity,
          boxStyle: { align: s.align ?? "left", valign: s.valign ?? "top" },
        }
      : {
          rich: resolved,
          boxW: (s.w ?? 0) > 0 ? s.w : Infinity,
          boxH: (s.h ?? 0) > 0 ? s.h : Infinity,
          boxStyle: { align: s.align ?? "left", lineSpacing: s.lineSpacing ?? 1, charSpacing: s.charSpacing ?? 0, wordSpacing: s.wordSpacing ?? 0, valign: s.valign ?? "top" },
        };
    return getTextLayout(gpu.CanvasKit, gpu.fontCollection, cmd, s.opacity ?? 1);
  });

  // Root box: the item's world top-left in the render-area frame, plus the
  // local→screen scale (zoom·world.scale) + rotation. The caret/selection are
  // positioned in LOCAL units inside a root CSS-transformed by this, so they land
  // exactly on the Skia glyphs at any zoom/rotation.
  let box = $derived.by(() => {
    const p = T.apply(node.world, 0, 0);
    const sc = worldToScreen(p.x, p.y);
    return {
      x: sc.x, y: sc.y,
      w: node.state.w ?? 0, h: node.state.h ?? 0,
      scale: zoom * (node.world.scale ?? 1),
      deg: (node.world.rotation ?? 0) * 180 / Math.PI,
    };
  });

  let caret = $derived(layout ? layout.caretRect(focus) : null);      // LOCAL {x, top, h}
  let selRects = $derived(layout && selEnd > selStart ? layout.selectionRects(selStart, selEnd) : []);
  // Pointer hit-surface size (LOCAL): cover the box AND all laid-out content.
  let hitW = $derived(layout ? Math.max(box.w, box.w > 0 ? 0 : layout.contentWidth()) : box.w);
  let hitH = $derived(layout ? Math.max(box.h, layout.contentBottom) : box.h);

  const textLen = () => runsLength(rich.runs);
  const clampOff = (o) => Math.max(0, Math.min(o, textLen()));

  // ── selection mutation ────────────────────────────────────────────────────────
  function setSel(a, f, keepGoal = false) { anchor = a; focus = f; if (!keepGoal) goalX = null; }
  function collapse(o) { setSel(o, o); }
  function moveTo(newFocus, shift) { const f = clampOff(newFocus); focus = f; if (!shift) anchor = f; goalX = null; }

  // ── text mutation (previews the model; one undo unit on commit) ───────────────
  // In-session undo/redo: a text-edit session is ONE doc-level undo unit
  // (commitTextEdit), but WITHIN the session Cmd+Z/Cmd+Shift+Z must undo/redo
  // keystrokes. The app's doc-level undo can't fire here (App.onKeydown early-returns
  // on the focused sink), so we keep a session-local stack of {value, caret}
  // snapshots taken BEFORE each mutation.
  const MAX_EDIT_HISTORY = 500; // per-session undo depth cap (a session is bounded)
  let editUndo = [];            // snapshots taken BEFORE each mutation (non-reactive)
  let editRedo = [];
  /** Command (mutates session history). Records the current value+caret, clears redo. */
  function pushHistory() {
    editUndo.push({ value: rich, anchor, focus });
    if (editUndo.length > MAX_EDIT_HISTORY) editUndo.shift();
    editRedo = [];
  }
  /** Command. The ONE boundary where this controller's rich editing model meets
   *  the WIDGET's stored shape: in plain mode the {runs,paras} model is flattened
   *  to a bare string (richTextToPlain) before it is staged, so a single-string
   *  widget never receives a rich value; in rich mode the value passes through.
   *  All preview writes (typing, IME, in-session undo/redo) go through here. */
  function stageValue(v) { app.previewTextValue(plain ? richTextToPlain(v) : v); }
  /** Command. Previews a new value AND records the prior one for in-session undo. */
  function preview(v) { pushHistory(); stageValue(v); }
  /** Command. Restores the previous in-session snapshot (value + caret). No-op at
   *  session start — exit (Esc) then Cmd+Z undoes the whole edit at the doc level. */
  function undoEdit() {
    if (composing || !editUndo.length) return;
    editRedo.push({ value: rich, anchor, focus });
    const s = editUndo.pop();
    stageValue(s.value); setSel(s.anchor, s.focus);
  }
  /** Command. Replays the next snapshot undone by undoEdit (value + caret). */
  function redoEdit() {
    if (composing || !editRedo.length) return;
    editUndo.push({ value: rich, anchor, focus });
    const s = editRedo.pop();
    stageValue(s.value); setSel(s.anchor, s.focus);
  }

  /** Command. Replaces [lo,hi) with `text`, inheriting the caret style (+ any
   * pending empty-caret style), then collapses the caret after the insert. */
  function replaceRange(lo, hi, text) {
    let v = rich;
    if (hi > lo) v = deleteRange(v, lo, hi, inherited);
    const at = lo;
    const insLen = [...text].length;
    v = insertText(v, at, text, inherited);
    if (insLen > 0 && Object.keys(pendingStyle).length)
      v = { runs: applyRunStyle(v.runs, at, at + insLen, pendingStyle, inherited), paras: v.paras };
    preview(v);
    collapse(at + insLen);
    pendingStyle = {};
  }
  function typeText(t) { replaceRange(selStart, selEnd, t); }
  function insertNewline() { replaceRange(selStart, selEnd, "\n"); }
  function deleteSelection() { preview(deleteRange(rich, selStart, selEnd, inherited)); collapse(selStart); }
  function backspace(to = selStart - 1) {
    if (selEnd > selStart) return deleteSelection(); // a selection wins over any target
    const from = clampOff(to);
    if (from < selStart) { preview(deleteRange(rich, from, selStart, inherited)); collapse(from); }
  }
  function deleteForward(to = selStart + 1) {
    if (selEnd > selStart) return deleteSelection();
    const end = clampOff(to);
    if (end > selStart) { preview(deleteRange(rich, selStart, end, inherited)); collapse(selStart); }
  }

  // ── navigation (all geometry from the shared layout) ──────────────────────────
  function lineStart(o) { const c = layout.caretRect(o); return layout.offsetAtPoint(-1, c.top + c.h / 2); }
  function lineEnd(o) { const c = layout.caretRect(o); return layout.offsetAtPoint(1e7, c.top + c.h / 2); }
  function moveVertical(dir, shift) {
    if (!layout) return;
    if (goalX == null) goalX = layout.caretRect(focus).x;
    const nf = layout.lineMove(focus, dir, goalX);
    focus = nf; if (!shift) anchor = nf; // preserve goalX across consecutive vertical moves
  }
  // macOS word semantics: whitespace between the caret and the word travels
  // WITH the word (skip it, then take the word boundary) — but a newline is a
  // hard stop, so a word hop never silently crosses lines. Shared by Alt+Arrow
  // navigation AND Alt+Backspace/Delete, so they can never disagree.
  function wordStartBefore(o) {
    const s = richTextToPlain(rich);
    while (o > 0 && /\s/.test(s[o - 1]) && s[o - 1] !== "\n") o--;
    return layout ? layout.wordAt(clampOff(o - 1)).start : o - 1;
  }
  function wordEndAfter(o) {
    const s = richTextToPlain(rich);
    while (o < s.length && /\s/.test(s[o]) && s[o] !== "\n") o++;
    if (!layout) return o + 1;
    const w = layout.wordAt(clampOff(o));
    return w.end > o ? w.end : layout.wordAt(clampOff(o + 1)).end;
  }
  function moveWord(dir, shift) {
    if (!layout) return moveTo(focus + dir, shift);
    moveTo(dir > 0 ? wordEndAfter(focus) : wordStartBefore(focus), shift);
  }

  // ── style edits (toolbar onstyle / onsizestep / Cmd+B·I·U / Cmd±) ─────────────
  // TWO run edits, ONE selection. `runsOf` below is always one of these; each is
  // the ONE expression of its edit, shared by the durable commit and the hover
  // preview so the previewed thing and the committed thing cannot drift.
  /** Query (reads the live selection offsets). `base`'s runs with `delta` applied
   *  over the selection — every ABSOLUTE style write (B/I/U, color, font, …). */
  function styledRuns(base, delta) {
    return applyRunStyle(base.runs, selStart, selEnd, delta, inherited);
  }
  /** Query (reads the live selection offsets). `base`'s runs with every covered
   *  run's size stepped BY `delta` px — the RELATIVE size write, which is a
   *  different primitive and not a delta object: an absolute {size: n} cannot
   *  express "shift each run by 2" and flattens a mixed selection to one run. */
  function sizeSteppedRuns(base, delta) {
    return adjustRunSize(base.runs, selStart, selEnd, delta, inherited);
  }

  // ── style HOVER PREVIEW (the FontPicker's live canvas preview) ────────────────
  // Hovering/arrowing a font in the picker must show that face ON THE CANVAS
  // without becoming an edit. The seam already exists: the WHOLE edit session
  // lives in app.previewDelta (stageValue) and only commitTextEdit turns it into
  // an undo unit — so a hover just stages a DIFFERENT value into the same slot.
  // What it must NOT do is call preview(): that pushes in-session undo history
  // (task "in-session undo/redo"), and a snapshot per hovered font would bury the
  // user's real keystrokes. So a hover goes through stageValue DIRECTLY.
  //
  // `stylePreview` = the state captured at the FIRST hover of a run of hovers:
  //   value — the rich value to restore on revert.
  //   dirty — whether the session had ALREADY staged an edit. When it had not,
  //           reverting must CLEAR the preview rather than re-stage an identical
  //           value: a bare hover must not leave a pending preview behind, or
  //           commitTextEdit would turn a mere hover into a no-op undo unit.
  let stylePreview = null;

  /** Query. The STORABLE rich value every style COMMIT starts from, and the base
   *  the TOOLBAR reads through styleBaseResolved: the pre-hover value while a
   *  hover preview is staged, else the live one. A hover preview is a transient
   *  canvas effect, NOT an edit — so the toolbar must not reflect it. This also
   *  breaks a FEEDBACK LOOP: the toolbar derives the FontPicker's `value` from
   *  these runs, so without it a staged preview would report the hovered font as
   *  the current one and the picker would immediately cancel its own preview. */
  function styleBase() {
    const live = rich; // ALWAYS read, so readers stay subscribed to the live value
    return stylePreview ? stylePreview.value : live;
  }

  /** Query. styleBase() with the widget-level fallbacks RESOLVED — what every
   *  style READER must use: the toolbar's B/I/U pressed state, its size readout
   *  and font name, and toggleStyle, which computes a next value from the current
   *  one. On an unresolved base those reads see `undefined` for a key the run
   *  never set, so Bold would render unset in a BOLD box and toggle to bold — a
   *  visible no-op. The WRITE still goes through styleBase(), so what is READ is
   *  resolved and what is STORED is not.
   *  stepSize no longer reads it: the same "resolve before deciding" duty moved
   *  INTO core/richtext.adjustRunSize, which resolves each covered run separately
   *  because a mixed selection has no single current value to resolve. */
  function styleBaseResolved() {
    return normalizeRichText(styleBase(), inherited);
  }

  /** Command. Live-previews a run edit over the selection WITHOUT committing and
   *  WITHOUT touching in-session history. A collapsed caret is a no-op: there is
   *  no glyph the preview could change (the durable path stashes pendingStyle
   *  instead, which by definition affects only text not yet typed). Each call
   *  re-applies from the CAPTURED base, so hovering A then B previews B alone
   *  rather than compounding — and so a size SCRUB, which sends the CUMULATIVE
   *  delta from where the gesture started on every frame, lands on the right
   *  value each frame instead of integrating its own previews. */
  function previewRunEdit(runsOf) {
    if (plain || selEnd <= selStart) return;
    if (!stylePreview) stylePreview = { value: rich, dirty: app.previewDelta !== null };
    // Declare the staged value TRANSIENT: every commit path drops it first, so a
    // click-away/slide-switch mid-hover commits the real value, not the hover.
    app.transientPreview = endStylePreview;
    const base = stylePreview.value;
    stageValue({ runs: runsOf(base), paras: base.paras });
  }
  /** Command. Previews an absolute run-style delta (the FontPicker's live canvas
   *  preview, and every toolbar button's hover). */
  function previewStyleOnSelection(delta) { previewRunEdit((base) => styledRuns(base, delta)); }
  /** Command. Previews a RELATIVE size step (the toolbar's +/- hover and every
   *  frame of the scrubbable size readout's drag). */
  function previewSizeStepOnSelection(delta) { previewRunEdit((base) => sizeSteppedRuns(base, delta)); }

  /** Command. Reverts a staged style hover preview, restoring exactly what the
   *  session held before it (or clearing the preview outright when the session
   *  was clean). A no-op when nothing is staged, so every close/leave/unmount
   *  path can call it unconditionally. */
  function endStylePreview() {
    if (!stylePreview) return;
    const { value, dirty } = stylePreview;
    stylePreview = null;
    app.transientPreview = null;
    if (dirty) stageValue(value);
    else app.cancelPreview();
  }

  /** Command. styleBase(), with any staged hover preview DISCARDED — the shared
   *  preamble of every durable style write. Discarding (not reverting) is right
   *  here: the caller is about to stage its own value over the same slot. */
  function takeStyleBase() {
    const base = styleBase();
    stylePreview = null;
    app.transientPreview = null;
    return base;
  }

  // A hover preview must never OUTLIVE this controller. Text edit can be
  // dismissed while the picker is open with a preview staged (click-away, slide
  // switch, Esc — all funnel through app.dismissTextEdit, which COMMITS whatever
  // previewDelta holds), and no pointerleave fires when the overlay simply
  // unmounts. Reverting on teardown is what stops a merely-hovered font from
  // being committed as though it were chosen.
  $effect(() => () => endStylePreview());

  /** Command. Applies a run-style delta: to the SELECTION if non-empty (via
   * applyRunStyle, offsets preserved), else stashed as the caret's pending style
   * for the next typed char (the PPT empty-caret convention).
   *
   * It applies over styleBase(), i.e. the value BEFORE any hover preview, and
   * DISCARDS that preview — a hover is not an edit, so the committed value and
   * the in-session snapshot must both start from the real one. Discarding here
   * is also what makes the picker's revert-on-close safe to fire after a click:
   * by then there is no preview left to revert. */
  function applyStyleToSelection(delta) {
    if (plain) return; // plain-string widget: no runs to style (no format toolbar)
    const base = takeStyleBase();
    if (selEnd > selStart) preview({ runs: styledRuns(base, delta), paras: base.paras });
    else pendingStyle = { ...pendingStyle, ...delta };
  }
  /** Command. Applies a paragraph-style delta to every paragraph the selection
   * touches (align etc.) via applyParaStyle — offsets/runs unchanged. Reads the
   * pre-hover runs (takeStyleBase) so a staged font preview can never be BAKED
   * into an unrelated paragraph commit. */
  function applyParaToSelection(delta) {
    if (plain) return; // plain-string widget: alignment lives on the Inspector row
    const base = takeStyleBase();
    preview({ runs: base.runs, paras: applyParaStyle(base.paras, base.runs, selStart, selEnd, delta) });
  }
  function toggleStyle(key) {
    if (plain) return; // plain-string widget: no bold/italic/underline runs
    const base = styleBaseResolved(); // the REAL state, resolved, never a hovered preview
    if (selEnd > selStart) {
      const cur = commonStyle(base.runs, selStart, selEnd, key);
      applyStyleToSelection({ [key]: cur === true ? false : true });
    } else {
      const cur = pendingStyle[key] ?? runStyleAt(base.runs, focus)[key];
      pendingStyle = { ...pendingStyle, [key]: cur === true ? false : true };
    }
  }
  /** Command. THE ONE SIZE-STEP ENTRY POINT — Cmd+Plus/Minus, the toolbar's +/-
   * buttons and the scrubbable size readout all land here, which is the fix for
   * the two paths disagreeing (measured on a 48+18 selection, one step: the
   * toolbar produced ONE run at 38, the keyboard ONE run at 50, and both destroyed
   * the run boundary). `delta` is RELATIVE px, so a mixed selection keeps its
   * relative differences: adjustRunSize resolves each covered run's own size and
   * shifts it.
   *
   * The CARET branch cannot use a run edit — there is no covered run — so it
   * stashes an absolute pending size for the next typed character, stepping from
   * any size already pending (repeated presses accumulate, as toggleStyle's caret
   * branch already does) and otherwise from the caret's own RESOLVED size. Both
   * branches floor through the same steppedSize. */
  function stepSize(delta) {
    if (plain) return; // plain-string widget: size lives on the Inspector row
    const base = takeStyleBase(); // the REAL value, never a hovered preview
    if (selEnd > selStart) { preview({ runs: sizeSteppedRuns(base, delta), paras: base.paras }); return; }
    const resolvedBase = normalizeRichText(base, inherited);
    const from = pendingStyle.size ?? runStyleAt(resolvedBase.runs, focus).size ?? DEFAULT_PARA_SIZE;
    pendingStyle = { ...pendingStyle, size: steppedSize(from, delta) };
  }

  // ── keyboard (the sink owns keydown; App.onKeydown early-returns on a focused
  // contentEditable, so no canvas shortcut fires) ──────────────────────────────
  function onKeydown(e) {
    if (e.isComposing) return; // IME owns the keystroke
    const mod = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;
    const k = e.key;
    // Escape COMMITS and is CONSUMED. stopPropagation is not optional here (and
    // is why the two sibling in-place editors, LatexEditController and
    // CodeEditController, both call it): commitTextEdit() clears app.textEditing
    // INSIDE this handler, so this controller — and with it the focused
    // contentEditable sink — is gone by the time the event reaches App.svelte's
    // window listener. Its isTypingTarget(document.activeElement) guard then sees
    // <body>, not the sink, and dispatches the canvas `deselect` entry: one
    // Escape both committed the edit AND cleared the selection (measured).
    // Every OTHER branch below keeps the sink mounted and focused, so that guard
    // still covers them (verified in tests/escape_propagation_probe.js).
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); app.commitTextEdit(); return; }
    if (mod && !shift && (k === "z" || k === "Z")) { e.preventDefault(); undoEdit(); return; }
    if (mod && ((shift && (k === "z" || k === "Z")) || k === "y" || k === "Y")) { e.preventDefault(); redoEdit(); return; }
    if (mod && (k === "a" || k === "A")) { e.preventDefault(); setSel(0, textLen()); return; }
    if (mod && (k === "b" || k === "B")) { e.preventDefault(); toggleStyle("bold"); return; }
    if (mod && (k === "i" || k === "I")) { e.preventDefault(); toggleStyle("italic"); return; }
    if (mod && (k === "u" || k === "U")) { e.preventDefault(); toggleStyle("underline"); return; }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); stepSize(SIZE_STEP); return; }
    if (mod && (k === "-" || k === "_")) { e.preventDefault(); stepSize(-SIZE_STEP); return; }
    // Clipboard: let the native copy/cut/paste events fire (handled below).
    if (mod && /^[cxvCXV]$/.test(k)) return;
    if (k === "ArrowLeft") { e.preventDefault(); if (e.altKey) moveWord(-1, shift); else if (mod) moveTo(lineStart(focus), shift); else moveTo(focus - 1, shift); return; }
    if (k === "ArrowRight") { e.preventDefault(); if (e.altKey) moveWord(1, shift); else if (mod) moveTo(lineEnd(focus), shift); else moveTo(focus + 1, shift); return; }
    if (k === "ArrowUp") { e.preventDefault(); moveVertical(-1, shift); return; }
    if (k === "ArrowDown") { e.preventDefault(); moveVertical(1, shift); return; }
    if (k === "Home") { e.preventDefault(); moveTo(lineStart(focus), shift); return; }
    if (k === "End") { e.preventDefault(); moveTo(lineEnd(focus), shift); return; }
    if (k === "Backspace") { e.preventDefault(); if (e.altKey) backspace(wordStartBefore(selStart)); else if (mod) backspace(lineStart(selStart)); else backspace(); return; }
    if (k === "Delete") { e.preventDefault(); if (e.altKey) deleteForward(wordEndAfter(selStart)); else if (mod) deleteForward(lineEnd(selStart)); else deleteForward(); return; }
    if (k === "Enter") { e.preventDefault(); insertNewline(); return; }
    if (!mod && k.length === 1) { e.preventDefault(); typeText(k); return; } // printable char
  }

  // ── IME composition: mirror the composing string into the model as a PROVISIONAL
  // run so it renders in Skia at the caret (WYSIWYG); commit on end ──────────────
  function onCompositionStart() {
    pushHistory(); // the whole IME composition is ONE in-session undo step
    composing = true;
    let base = rich;
    if (selEnd > selStart) { base = deleteRange(base, selStart, selEnd, inherited); stageValue(base); }
    compAnchor = selStart;
    compBase = base;
    collapse(compAnchor);
  }
  function onCompositionUpdate(e) {
    if (!compBase) return;
    const data = e.data ?? "";
    stageValue(insertText(compBase, compAnchor, data, inherited));
    const len = [...data].length;
    setSel(compAnchor + len, compAnchor + len);
  }
  function onCompositionEnd(e) {
    const data = e.data ?? "";
    stageValue(insertText(compBase ?? rich, compAnchor, data, inherited));
    collapse(compAnchor + [...data].length);
    composing = false; compBase = null;
    if (sinkEl) sinkEl.textContent = ""; // drop the native composing text (event source only)
  }

  // ── clipboard ─────────────────────────────────────────────────────────────────
  const selectedPlain = () => [...richTextToPlain(rich)].slice(selStart, selEnd).join("");
  function onCopy(e) { e.preventDefault(); e.clipboardData.setData("text/plain", selectedPlain()); }
  function onCut(e) { e.preventDefault(); e.clipboardData.setData("text/plain", selectedPlain()); deleteSelection(); }
  function onPaste(e) { e.preventDefault(); const t = e.clipboardData?.getData("text/plain") ?? ""; if (t) typeText(t); }

  // ── pointer: click-to-place caret + drag-select + double-click word ───────────
  function localFromEvent(e) {
    const rect = document.querySelector(".render-area").getBoundingClientRect();
    const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    return T.apply(T.invert(node.world), w.x, w.y); // world → item LOCAL
  }
  function focusSink() { if (sinkEl) sinkEl.focus({ preventScroll: true }); }
  function onHitPointerDown(e) {
    if (!layout || e.button !== 0) return;
    e.preventDefault(); // keep focus in the sink (don't let the div steal it)
    hitEl.setPointerCapture(e.pointerId);
    const lp = localFromEvent(e);
    const off = layout.offsetAtPoint(lp.x, lp.y);
    collapse(off);
    pdrag = { anchor: off };
    focusSink();
  }
  function onHitPointerMove(e) {
    if (!pdrag || !layout) return;
    const lp = localFromEvent(e);
    setSel(pdrag.anchor, layout.offsetAtPoint(lp.x, lp.y));
  }
  function onHitPointerUp(e) {
    pdrag = null;
    if (hitEl?.hasPointerCapture?.(e.pointerId)) hitEl.releasePointerCapture(e.pointerId);
    focusSink();
  }
  function onHitDblClick(e) {
    if (!layout) return;
    e.preventDefault();
    const lp = localFromEvent(e);
    const w = layout.wordAt(layout.offsetAtPoint(lp.x, lp.y));
    setSel(w.start, w.end);
    pdrag = null;
    focusSink();
  }

  // ── seed on mount (focus the sink, caret at end) ──────────────────────────────
  $effect(() => {
    if (sinkEl && !seeded) { collapse(textLen()); focusSink(); seeded = true; }
  });

  // Dev/test seam (mirrors window.__powerrp_app). Headless probes drive the REAL
  // methods; the caret/offset accessors return render-area-frame screen geometry
  // so a probe can assert caret-on-glyph accuracy across mixed runs. Cleared on
  // unmount so it never dangles.
  function offsetAtScreen(sx, sy) {
    if (!layout) return 0;
    const w = screenToWorld(sx, sy);
    const lp = T.apply(T.invert(node.world), w.x, w.y);
    return layout.offsetAtPoint(lp.x, lp.y);
  }
  function caretScreen(off = focus) {
    if (!layout) return null;
    const c = layout.caretRect(off);
    const top = T.apply(node.world, c.x, c.top);
    const bot = T.apply(node.world, c.x, c.top + c.h);
    const a = worldToScreen(top.x, top.y), b = worldToScreen(bot.x, bot.y);
    return { x: a.x, y: a.y, x2: b.x, y2: b.y };
  }
  function selectionScreenRects() {
    if (!layout) return [];
    return layout.selectionRects(selStart, selEnd).map((r) => {
      const p = T.apply(node.world, r.x, r.y);
      const s = worldToScreen(p.x, p.y);
      return { x: s.x, y: s.y, w: r.w * box.scale, h: r.h * box.scale };
    });
  }
  $effect(() => {
    window.__powerrp_textEdit = {
      applyStyle: applyStyleToSelection,
      applyPara: applyParaToSelection,
      // The RELATIVE size step, exposed so a probe can drive the SAME entry point
      // the toolbar buttons, the scrubbable readout and Cmd+/- all go through —
      // proving the two paths agree instead of testing one of them twice.
      stepSize,
      previewSizeStep: previewSizeStepOnSelection,
      endStylePreview,
      setSelection: (a, b) => setSel(a, b),
      getSelection: () => ({ start: selStart, end: selEnd, anchor, focus }),
      placeCaretAtScreen: (sx, sy) => { collapse(offsetAtScreen(sx, sy)); focusSink(); },
      offsetAtScreen,
      caretScreen,
      selectionScreenRects,
    };
    return () => { if (window.__powerrp_textEdit) delete window.__powerrp_textEdit; };
  });

  // Sink position (LOCAL, at the caret) so the OS IME candidate window appears at
  // the caret. Kept tiny + transparent; its content is an event source only.
  let sinkStyle = $derived(caret
    ? `left:${caret.x}px; top:${caret.top}px; width:${Math.max(1, caret.h * 0.5)}px; height:${caret.h}px;`
    : "left:0; top:0; width:1px; height:1px;");
  // Caret thickness in LOCAL px so it renders ~CARET_SCREEN_PX on screen.
  let caretW = $derived(CARET_SCREEN_PX / (box.scale || 1));
</script>

<!-- The root sits at the item's world top-left (render-area frame) and carries the
     item's world rotation + scale, so its children use LOCAL (world) coordinates —
     the caret/selection land on the Skia glyphs at any zoom. Keeps the
     `.text-edit-overlay-root` class for App.svelte's click-away/toolbar guards. -->
<div
  class="text-edit-overlay-root"
  style:left="{box.x}px"
  style:top="{box.y}px"
  style:transform="rotate({box.deg}deg) scale({box.scale})"
>
  <!-- Self-drawn selection bands (behind the glyphs visually — translucent). -->
  {#each selRects as r}
    <div class="text-edit-selrect" style:left="{r.x}px" style:top="{r.y}px" style:width="{r.w}px" style:height="{r.h}px"></div>
  {/each}

  <!-- Self-drawn caret at the focus offset (blinks unless a range is selected). -->
  {#if caret}
    <div class="text-edit-caret" class:has-selection={selEnd > selStart} style:left="{caret.x}px" style:top="{caret.top}px" style:width="{caretW}px" style:height="{caret.h}px"></div>
  {/if}

  <!-- Transparent pointer hit-surface over the box+content: click-to-place,
       drag-select, double-click word. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="text-edit-hit"
    bind:this={hitEl}
    style:width="{hitW}px"
    style:height="{hitH}px"
    onpointerdown={onHitPointerDown}
    onpointermove={onHitPointerMove}
    onpointerup={onHitPointerUp}
    onpointercancel={onHitPointerUp}
    ondblclick={onHitDblClick}
  ></div>

  <!-- Hidden contenteditable input sink: keystrokes + IME + clipboard only. Its
       layout is NEVER read (the model is the source of truth); it stays empty
       except transiently during IME composition. -->
  <div
    class="text-edit-sink"
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    spellcheck="false"
    bind:this={sinkEl}
    style={sinkStyle}
    onkeydown={onKeydown}
    oncompositionstart={onCompositionStart}
    oncompositionupdate={onCompositionUpdate}
    oncompositionend={onCompositionEnd}
    oncopy={onCopy}
    oncut={onCut}
    onpaste={onPaste}
  ></div>

  <!-- The floating rich-text format toolbar is a RICH-mode affordance only: a
       plain-string widget has no runs to style, so plain mode shows no toolbar
       (its font/size/color/align live on the Inspector rows). -->
  {#if !plain}
    <TextFormatToolbar
      {app}
      boxScale={box.scale}
      onstyle={applyStyleToSelection}
      onstylepreview={previewStyleOnSelection}
      onstylepreviewend={endStylePreview}
      onsizestep={stepSize}
      onsizesteppreview={previewSizeStepOnSelection}
      onparastyle={applyParaToSelection}
      selRange={{ start: selStart, end: selEnd }}
      runsAt={() => styleBaseResolved().runs}
      parasAt={() => styleBase().paras}
      boxAlign={node.state.align ?? "left"}
    />
  {/if}
</div>
