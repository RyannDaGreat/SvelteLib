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
    normalizeRichText, richTextToPlain, runsLength, runStyleAt, commonStyle,
    applyRunStyle, applyParaStyle, insertText, deleteRange,
  } from "../core/richtext.js";
  import TextFormatToolbar from "./TextFormatToolbar.svelte";

  // app = the app store; node = the edited item's derived render node (preview-
  // blended, so live edits reflect as you type); gpu = the shared SkiaSurface
  // (gpu.CanvasKit + gpu.fontCollection — the SAME instances the render uses);
  // worldToScreen/screenToWorld = the PanZoom camera maps (render-area frame);
  // zoom = viewport.zoom.
  let { app, node, gpu, worldToScreen, screenToWorld, zoom } = $props();

  const SIZE_STEP = 2;   // px per Cmd+/- (the PPT default increment; matches the toolbar)
  const CARET_SCREEN_PX = 2; // caret thickness on screen (counter-scaled to LOCAL below)

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
  // text plugin emit() exactly so the editor's layout equals the render's.
  let inherited = $derived({
    font: node.state.font ?? DEFAULT_FONT, size: node.state.size ?? 36,
    color: node.state.color ?? "#000000", bold: node.state.bold ?? false,
  });
  let rich = $derived(normalizeRichText(node.state.text, inherited));

  // ── geometry: the CACHED CanvasKit Paragraph stack the RENDER also draws ──────
  // Built through the ONE getTextLayout path with the SAME cmd the text plugin
  // emits, so caret/selection come from the identical shaped layout as the glyphs.
  let layout = $derived.by(() => {
    if (!gpu) return null;
    const s = node.state;
    const cmd = {
      rich,
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
  /** Command. Replaces [lo,hi) with `text`, inheriting the caret style (+ any
   * pending empty-caret style), then collapses the caret after the insert. */
  function replaceRange(lo, hi, text) {
    let v = rich;
    if (hi > lo) v = deleteRange(v, lo, hi);
    const at = lo;
    const insLen = [...text].length;
    v = insertText(v, at, text);
    if (insLen > 0 && Object.keys(pendingStyle).length)
      v = { runs: applyRunStyle(v.runs, at, at + insLen, pendingStyle), paras: v.paras };
    app.previewTextValue(v);
    collapse(at + insLen);
    pendingStyle = {};
  }
  function typeText(t) { replaceRange(selStart, selEnd, t); }
  function insertNewline() { replaceRange(selStart, selEnd, "\n"); }
  function deleteSelection() { app.previewTextValue(deleteRange(rich, selStart, selEnd)); collapse(selStart); }
  function backspace() {
    if (selEnd > selStart) return deleteSelection();
    if (selStart > 0) { app.previewTextValue(deleteRange(rich, selStart - 1, selStart)); collapse(selStart - 1); }
  }
  function deleteForward() {
    if (selEnd > selStart) return deleteSelection();
    if (selStart < textLen()) { app.previewTextValue(deleteRange(rich, selStart, selStart + 1)); collapse(selStart); }
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
  function moveWord(dir, shift) {
    if (!layout) return moveTo(focus + dir, shift);
    if (dir > 0) {
      const w = layout.wordAt(focus);
      moveTo(w.end > focus ? w.end : layout.wordAt(clampOff(focus + 1)).end, shift);
    } else {
      const w = layout.wordAt(clampOff(focus - 1));
      moveTo(w.start < focus ? w.start : layout.wordAt(clampOff(focus - 1)).start, shift);
    }
  }

  // ── style edits (toolbar onstyle / Cmd+B·I·U / Cmd±) ──────────────────────────
  /** Command. Applies a run-style delta: to the SELECTION if non-empty (via
   * applyRunStyle, offsets preserved), else stashed as the caret's pending style
   * for the next typed char (the PPT empty-caret convention). */
  function applyStyleToSelection(delta) {
    if (selEnd > selStart) app.previewTextValue({ runs: applyRunStyle(rich.runs, selStart, selEnd, delta), paras: rich.paras });
    else pendingStyle = { ...pendingStyle, ...delta };
  }
  /** Command. Applies a paragraph-style delta to every paragraph the selection
   * touches (align etc.) via applyParaStyle — offsets/runs unchanged. */
  function applyParaToSelection(delta) {
    app.previewTextValue({ runs: rich.runs, paras: applyParaStyle(rich.paras, rich.runs, selStart, selEnd, delta) });
  }
  function toggleStyle(key) {
    if (selEnd > selStart) {
      const cur = commonStyle(rich.runs, selStart, selEnd, key);
      applyStyleToSelection({ [key]: cur === true ? false : true });
    } else {
      const cur = pendingStyle[key] ?? runStyleAt(rich.runs, focus)[key];
      pendingStyle = { ...pendingStyle, [key]: cur === true ? false : true };
    }
  }
  function stepSize(delta) {
    const base = commonStyle(rich.runs, selStart, selEnd, "size") ?? runStyleAt(rich.runs, selStart).size ?? 36;
    const size = Math.max(1, base + delta);
    if (selEnd > selStart) applyStyleToSelection({ size });
    else pendingStyle = { ...pendingStyle, size };
  }

  // ── keyboard (the sink owns keydown; App.onKeydown early-returns on a focused
  // contentEditable, so no canvas shortcut fires) ──────────────────────────────
  function onKeydown(e) {
    if (e.isComposing) return; // IME owns the keystroke
    const mod = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); app.commitTextEdit(); return; }
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
    if (k === "Backspace") { e.preventDefault(); backspace(); return; }
    if (k === "Delete") { e.preventDefault(); deleteForward(); return; }
    if (k === "Enter") { e.preventDefault(); insertNewline(); return; }
    if (!mod && k.length === 1) { e.preventDefault(); typeText(k); return; } // printable char
  }

  // ── IME composition: mirror the composing string into the model as a PROVISIONAL
  // run so it renders in Skia at the caret (WYSIWYG); commit on end ──────────────
  function onCompositionStart() {
    composing = true;
    let base = rich;
    if (selEnd > selStart) { base = deleteRange(base, selStart, selEnd); app.previewTextValue(base); }
    compAnchor = selStart;
    compBase = base;
    collapse(compAnchor);
  }
  function onCompositionUpdate(e) {
    if (!compBase) return;
    const data = e.data ?? "";
    app.previewTextValue(insertText(compBase, compAnchor, data));
    const len = [...data].length;
    setSel(compAnchor + len, compAnchor + len);
  }
  function onCompositionEnd(e) {
    const data = e.data ?? "";
    app.previewTextValue(insertText(compBase ?? rich, compAnchor, data));
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

  <TextFormatToolbar
    {app}
    boxScale={box.scale}
    onstyle={applyStyleToSelection}
    onparastyle={applyParaToSelection}
    selRange={{ start: selStart, end: selEnd }}
    runsAt={() => rich.runs}
    parasAt={() => rich.paras}
    boxAlign={node.state.align ?? "left"}
  />
</div>
