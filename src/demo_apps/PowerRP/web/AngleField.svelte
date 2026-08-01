<!--
  AngleField — THE "angle" property field (the angle sibling of NumericField /
  ColorField / BooleanField). It edits a heading in DEGREES with a rotary DIAL
  you drag around a circle, plus a typed-degrees box for exact entry. The
  heading convention matches the rest of the app: 0° = +x (right), 90° = +y
  (down).

  WHERE IT IS USED:
    - kind:"angle" property rows, via the Inspector's field dispatcher
      (web/Inspector.svelte) — self-writes to `path` on `app` exactly like
      ColorField (preview mid-gesture, commit on settle, one undo unit; the
      row's shared KeyframeControls keyframe it like any other property).
      That is every real heading in the app: the UNIVERSAL transform `rotation`
      (so every bbox widget), the shapeshifter start angles, the particle launch
      angle, the halftone screen angles, the demo widgets' light/streak/limb
      directions.
    - the LINEAR-GRADIENT DIRECTION inside PaintField — there the write is NOT a
      single scalar (it must be able to rewrite the paint alongside the angle),
      so PaintField passes `onpreview`/`oncommit` callbacks that own the write.

  THE HEADING IS UNBOUNDED — the MULTI-TURN INVARIANT, and the one thing about
  this field that is easy to get catastrophically wrong. A dial reads an
  ABSOLUTE pointer heading, which is only ever known modulo a full turn, so a
  dial that WRITES that heading folds every value into [0, 360) — and a rotation
  keyframed to 720° (two whole spins, which the manifest requires of the
  transform: "Rotation is an unwrapped angle (deltas can spin 720°)") silently
  collapses to 0, i.e. to no rotation at all. So:
    - the NEEDLE draws wrapDegrees(v) — a needle can only point one way;
    - the READOUT (typed box + evaluated badge) shows the RAW value, so two
      turns read as "720", not as a lie that says "0" (NumericField's rotation
      scrubber has always shown raw unwrapped degrees — this matches it);
    - a DRAG integrates core/properties.js shortestTurn() from the previous
      value, so turn count accumulates (350 → 370, never 350 → 10) and the old
      ±360 seam jump when the pointer crossed the top is gone as a side effect;
    - typed entry and arrow-key nudges are likewise never folded.
  Every consumer takes the heading through cos/sin (or wraps internally, like
  angleToLinearEndpoints), so an unwrapped value renders identically.

  DISPLAY UNITS (`display`, e.g. "degrees" — web/displayUnits.js): the dial ALWAYS
  works in degrees; `display` bridges to whatever the row STORES. `rotation`
  stores RADIANS and passes display:"degrees"; gradient `angle`/`particleAngle`
  store raw degrees and pass nothing (identity). Conversion happens ONLY at this
  field's write/read boundary, exactly as in NumericField — storage is never
  migrated. An EQUATION's text is authored in STORED space and stored verbatim
  (converting arbitrary arithmetic between units is ill-defined — NumericField's
  ruling); only its evaluated BADGE is shown in degrees.
  BEWARE two unrelated senses of "display" in this file: `unit.toDisplay` /
  `unit.fromDisplay` convert UNITS (radians ↔ degrees), while
  core/expressions.js `storedToDisplay` / `displayToStored` map equation SLUGS
  (item names ↔ @itemIds). They compose; they are not the same axis.

  EQUATION MODE (manifest Tier 0, "equation-mode (`=`) on EVERY property, no
  exceptions"). A heading may be BOUND to an expression instead of a literal —
  the field is a surfacing of THE ONE equation UX that NumericField (the older
  precedent, 2026-07-14) established; nothing here is a second design:
    - the stored value is read RAW (getPath(app.rawState(), path)) so a stored
      equation is seen AS an equation. It is NEVER coerced to a number — the
      dial/degrees box are simply replaced by the expression editor, exactly as
      NumericField replaces its scrubber.
    - ONE symmetric text-entry path decides the type from WHAT WAS TYPED
      (angleFromDraft): a reference-free expression ("45", "30 + 15") commits as
      a plain NUMBER, anything with references commits as an "=" EQUATION — so
      clearing a binding back to a literal is just typing a number.
    - two surfacings open that ONE path: the hover-only ƒ button (NumericField's
      `.eq-open` affordance) and typing a leading "=" into the degrees box.
    - the same autocomplete (EquationSuggest), the same syntax-highlight overlay
      (equationTokenSpans), the same evaluated/error badge.
    - an equation is stored WITH the leading "=" — the UNIVERSAL marker
      core/expressions.js requires on a slot whose plugin default is not itself a
      number (PaintField's equation paint does the same).

  Live semantics (the house preview/commit contract, same as ColorField):
    drag / arrow-key nudge / equation keystroke → preview (viewport re-renders
    live; document unchanged, no undo entry)
    pointer release / typed Enter / blur → commit (EXACTLY ONE undo unit)

  Styling: the equation chrome REUSES app.css's `.numfield`/`.eq-*` rules
  verbatim (the same DOM NumericField renders — duplicating that carefully-tuned
  overlay/specificity CSS would be the opposite of DRY). Everything specific to
  the dial is an inline style over the app's --a-*/--fg/--border/--accent tokens
  (no <style> block — the PaintField/ColorField-eyedropper house convention).
  The SVG uses a unitless 0..100 viewBox; those are DRAWING coordinates (like a
  path's `d`), not CSS px — the on-screen SIZE comes from --a-control-h. No
  hardcoded colors or CSS pixels. Corners are SQUARE (app chrome is square;
  --radius is the cap for src/lib components only); the dial's border-radius:50%
  is a TRUE CIRCLE, not a rounded corner.

  Props: app (required for equation mode — it owns rawState/state/preview),
  path (state path; with it the field reads the stored value itself), label,
  value (the caller's evaluated heading in STORED units — used when the path
  holds nothing yet, e.g. a LEGACY gradient whose direction still lives in
  from/to endpoints), display (display-unit name, e.g. "degrees"; null =
  identity), disabled, onpreview(value), oncommit(value) — `value` is a STORED-
  unit number or an "=" equation string.
  Styling lives in app.css (.numfield / .anglefield-* / .angle-dial; app
  convention: no <style>, no inline style attributes — the dial's live drag
  CURSOR is the sole exception, being gesture state rather than a rule).
-->
<script module>
  import { wrapDegrees, shortestTurn } from "../core/properties.js";
  import { displayToStored, storedToDisplay, compiled, evalAst } from "../core/expressions.js";

  // The UNIVERSAL equation marker (mirrors core/expressions.js EQ_PREFIX_RE):
  // a property is an equation iff its string value starts with "=".
  const EQ_MARKER = /^\s*=\s*/;

  /**
   * Pure function. An angle equation's DISPLAY draft: the stored "=" marker is
   * kept verbatim (the highlight overlay renders it as plain lead text and
   * displayToStored strips it again on commit) and the body is slug-mapped by
   * storedToDisplay, so a stored @itemId shows as the item's current name.
   *
   * @example // angleDraftFromStored("=@a1.x + 10", {items: {a1: {type: "rect", name: "Box"}}}) === "=box.x + 10"
   * @example // angleDraftFromStored("=tilt * 2", {vars: {tilt: 33}, items: {}}) === "=tilt * 2"
   */
  export function angleDraftFromStored(stored, state) {
    const body = stored.replace(EQ_MARKER, "");
    return stored.slice(0, stored.length - body.length) + storedToDisplay(body, state);
  }

  /**
   * Pure function. THE symmetric text-entry decision, ported from NumericField:
   * WHAT WAS TYPED decides the type. A reference-free expression commits as a
   * plain NUMBER — in DEGREES, the unit the box is typed in, NEVER folded into
   * [0, 360) (the multi-turn invariant: a user who types 720 to set up a
   * two-spin keyframe must get 720); anything that REFERENCES something commits
   * as an "=" EQUATION STRING, already in STORED space (the universal marker
   * core requires on a slot whose plugin default is not itself a number).
   * Throws on bad syntax, an unknown reference, or a non-finite result — the
   * caller reports it loudly rather than storing a silent 0.
   *
   * The caller converts a returned NUMBER out of degrees into the row's stored
   * unit (unit.fromDisplay); an equation string is stored verbatim.
   *
   * @example // angleFromDraft("45", state) === 45
   * @example // angleFromDraft("720", state) === 720           (NOT folded — two whole turns)
   * @example // angleFromDraft("-90", state) === -90           (NOT folded to 270)
   * @example // angleFromDraft("30 + 15", state) === 45        (arithmetic, no refs → a number)
   * @example // angleFromDraft("=tilt * 2", {vars: {tilt: 33}, items: {}}) === "=tilt * 2"
   * @example // angleFromDraft("box.rotation", {items: {a1: {type: "rect", name: "Box"}}}) === "=@a1.rotation"
   */
  export function angleFromDraft(draft, state) {
    const storedForm = displayToStored(draft, state); // throws on bad syntax / unknown refs
    const { ast, refs } = compiled(storedForm);
    if (refs.length > 0) return `=${storedForm}`;
    const degrees = evalAst(ast, () => 0);
    if (!Number.isFinite(degrees)) throw new Error(`"${draft}" is not a finite angle`);
    return degrees;
  }
</script>

<script>
  import "iconify-icon";
  import Tooltip from "../../../lib/Tooltip.svelte";
  import { fieldOwnsKeydown } from "../../../lib/fieldKeys.js";
  import EquationSuggest from "./EquationSuggest.svelte";
  import { getPath } from "../core/deltas.js";
  import { equationTokenSpans } from "../core/expressions.js";
  import { suggestEquation, acceptSuggestion } from "../core/equationSuggest.js";
  import { makeEquationSuggestKeydown } from "./equationSuggestKeys.js";
  import { displayUnit } from "./displayUnits.js";
  import { fanOutPairs } from "../core/multiselect.js";

  let {
    app = null,
    path = null,
    paths = null,
    label,
    value = 0,
    display = null,
    disabled = false,
    onpreview = null,
    oncommit = null,
  } = $props();

  /**
   * THE WRITE TARGETS. Reads stay on the singular `path` (the PRIMARY item — in a
   * multi-selection every selected item agrees on this value, or the row would be
   * showing the MIXED mark instead of this field), while WRITES fan out to all of
   * them. `paths` absent = the single-selection case, byte-identically as before.
   */
  let writePaths = $derived(paths ?? [path]);

  // Display-unit transform (`rotation` edits in degrees though core stores
  // radians; identity for a row that already stores degrees). DISPLAY ONLY —
  // never migrates storage. Same seam, same module, as NumericField.
  let unit = $derived(displayUnit(display));

  // ── SVG drawing geometry (unitless viewBox coordinates, NOT CSS px) ──────────
  const VIEWBOX = 100; // the dial's coordinate space is 0..VIEWBOX square
  const CENTER = VIEWBOX / 2;
  const RING_R = 42; // dial ring radius
  const KNOB_R = 7; // draggable knob radius at the needle tip
  const HUB_R = 3; // center pivot dot
  const TICK_INNER = 36; // cardinal tick inner radius
  // Keyboard nudge steps (semantic constants — degrees per arrow press).
  const NUDGE_STEP_DEG = 1;
  const NUDGE_COARSE_DEG = 15; // with Shift held
  // The typed box and the evaluated badge show TENTHS of a degree (float dust
  // from a dragged/typed heading never reaches the user).
  const TENTHS_PER_DEGREE = 10;

  let svgEl = $state(null);
  // The in-flight dial drag, or null: {value, pointer} both in DISPLAY degrees.
  // `value` is the heading the gesture has integrated so far (turn count and
  // all) and `pointer` the pointer heading it was integrated from — that pair IS
  // the integrator's whole state, so the accumulated turns can never be lost to
  // a reactive round-trip through the document.
  let drag = $state(null);
  let dragging = $derived(drag !== null);

  // ── Stored (raw) vs settled (evaluated) — NumericField's split ──────────────
  // The RAW read is the ONLY way to see an equation: the `value` prop arrives
  // EVALUATED (the Inspector even coerces it with Number()), so reading it would
  // silently turn a binding into a literal. When there is no `path` the field is
  // driven purely by the caller's `value` (the callback-only mode) and equation
  // mode is unavailable — there is nothing to read an expression out of.
  let bound = $derived(!!app && !!path);
  let stored = $derived(bound ? getPath(app.rawState(), path) : value);
  // Equation mode needs the DOCUMENT (to read the expression, resolve slugs and
  // show the evaluated result), so it is available only on a bound field.
  let isEquation = $derived(bound && typeof stored === "string");
  let settled = $derived(bound ? getPath(app.state(), path) : undefined);
  let error = $derived(bound ? app.exprErrorAt(path) : null);

  // The heading the field holds, in STORED units. `settled` (evaluated —
  // equations resolved by core) is authoritative; `value` covers the cases where
  // the path holds nothing: callback-only mode, and a LEGACY gradient whose
  // direction still lives in its from/to endpoints (PaintField derives the
  // heading and passes it in). A NON-FINITE value can only be an equation core
  // ALREADY reported (a wrong-kind or failed result); the error badge carries the
  // message, so the dial parks at 0° instead of drawing NaN — the affordance IS
  // the report.
  let source = $derived(settled === undefined ? value : settled);
  // DISPLAY degrees, RAW — unwrapped, so a keyframed 720° reads as 720 and not as
  // a "0" that lies about two whole turns (the multi-turn invariant, header).
  let displayDeg = $derived(Number.isFinite(source) ? unit.toDisplay(source) : 0);
  // ...and the same heading FOLDED, for the needle alone: geometry can only point
  // one way, so this is the only place a wrap is correct.
  let needleDeg = $derived(wrapDegrees(displayDeg));
  let rad = $derived((needleDeg * Math.PI) / 180);
  // Needle tip in SVG coords (0° points +x/right, 90° points +y/down — the SVG
  // axes already run x-right / y-down, so the convention maps directly).
  let tipX = $derived(CENTER + RING_R * Math.cos(rad));
  let tipY = $derived(CENTER + RING_R * Math.sin(rad));
  let shownDeg = $derived(Math.round(displayDeg * TENTHS_PER_DEGREE) / TENTHS_PER_DEGREE);

  // ── Text entry (the ONE path: degrees box AND equation editor) ──────────────
  // `textEntry` is entry opened from a LITERAL (the ƒ button or a typed "="),
  // before any equation exists in the document; a stored equation shows the
  // editor on its own.
  let textEntry = $state(false);
  let focused = $state(false);
  let invalid = $state(false);
  let draft = $state("");
  let eqInputEl = $state(null);
  let showText = $derived(isEquation || textEntry);

  // Keep the draft synced to the document while the user is NOT typing — a
  // bind:value-style local buffer avoids caret fights with live preview.
  $effect(() => {
    if (!focused) draft = isEquation ? angleDraftFromStored(stored, app.rawState()) : String(shownDeg);
  });

  // The equation's OWNING item id, enabling `self.` completion — mirrors
  // NumericField's derivation (evaluateState resolves `self` to the item that
  // OWNS the equation slot, i.e. path[1] when path[0] === "items").
  let selfId = $derived(path?.[0] === "items" ? path[1] : null);

  // ── Syntax highlight spans (manifest "Equation syntax highlighting") ────────
  // The overlay renders these BEHIND a transparent-text input; classes come from
  // the REAL tokenizer/resolver, never a regex re-lex. Same construction as
  // NumericField's buildHighlightPieces.
  let highlightPieces = $derived(buildHighlightPieces(showText ? draft : ""));
  let highlightEl = $state(null);

  /** Query (reads the document, for slug/anchor classification). Interleaves the
   * tokenizer's classified spans with the plain gaps between them, preserving the
   * leading "=" marker as plain lead text.
   *
   * @example // buildHighlightPieces("=2 + 2") → [{text: "=", cls: null}, {text: "2", cls: "num"}, …]
   */
  function buildHighlightPieces(text) {
    const clean = text.replace(EQ_MARKER, "");
    const lead = text.slice(0, text.length - clean.length); // preserved "= " prefix (plain)
    // Project-script exports count as resolvable identifiers here too — see
    // NumericField's note (a working equation must never paint red).
    const spans = bound ? equationTokenSpans(clean, app.rawState(), selfId, app.projectScriptExports()) : [];
    const pieces = lead ? [{ text: lead, cls: null }] : [];
    let last = 0;
    for (const s of spans) {
      if (s.start > last) pieces.push({ text: clean.slice(last, s.start), cls: null }); // whitespace gap
      pieces.push({ text: clean.slice(s.start, s.end), cls: s.cls });
      last = s.end;
    }
    if (last < clean.length) pieces.push({ text: clean.slice(last), cls: null }); // trailing space
    return pieces;
  }

  /** Command. Keeps the highlight overlay's horizontal scroll pinned to the
   * input's, so a long expression that scrolls past the box edge stays aligned
   * under the caret. */
  function syncScroll() {
    if (highlightEl && eqInputEl) highlightEl.scrollLeft = eqInputEl.scrollLeft;
  }

  // ── Autocomplete (manifest "EQUATION DISCOVERABILITY") ─────────────────────
  // Re-ranked on every keystroke from the CURRENT caret position; suggestionsOpen
  // is a SEPARATE flag from "candidates.length > 0" so one Escape can close an
  // open list without the next keystroke reopening it from stale candidates.
  let suggestionsOpen = $state(false);
  let highlighted = $state(0);
  let candidates = $derived(
    suggestionsOpen && eqInputEl && bound
      // Project-script exports are offered here too — see NumericField's note.
      ? suggestEquation(draft, eqInputEl.selectionStart ?? draft.length, app.rawState(), app.registry, selfId, app.projectScriptExports())
      : [],
  );
  // Clamp the highlight when the candidate set shrinks so it never points past
  // the end of a shorter list.
  $effect(() => {
    if (highlighted >= candidates.length) highlighted = Math.max(0, candidates.length - 1);
  });

  // ── The write boundary (the ONLY place units are converted) ─────────────────
  // Everything above this line is DISPLAY degrees (what the dial and box work
  // in); everything the document sees is STORED units. A number crosses through
  // unit.fromDisplay; an "=" equation string is already stored-space and crosses
  // verbatim (see the header note on why equation TEXT is never unit-converted).

  /** Query (reads the `display` prop's unit). A display-space heading — or an
   * already-stored equation string — in STORED units. Named for the CONVERSION,
   * not the noun: `stored` is taken by the raw READ above, and the two must never
   * be confused.
   *
   * @example // toStoredUnit(90) === 1.5707963267948966   when display = "degrees"
   * @example // toStoredUnit(90) === 90                   when display = null (identity)
   * @example // toStoredUnit("=tilt * 2") === "=tilt * 2" (equations are stored-space already)
   */
  function toStoredUnit(v) {
    return typeof v === "number" ? unit.fromDisplay(v) : v;
  }

  /** Command. Live-preview a heading (viewport re-renders; doc unchanged). The
   * value is DISPLAY degrees (number) or an "=" equation string. */
  function emitPreview(v) {
    if (onpreview) onpreview(toStoredUnit(v));
    else if (bound) app.setPreview(fanOutPairs(writePaths, toStoredUnit(v)));
  }
  /** Command. Commit a heading as ONE undo unit. The value is DISPLAY degrees
   * (number) or an "=" equation string. */
  function emitCommit(v) {
    if (oncommit) oncommit(toStoredUnit(v));
    else if (bound) {
      app.setPreview(fanOutPairs(writePaths, toStoredUnit(v)));
      app.commitPreview();
    }
  }

  // ── The dial ────────────────────────────────────────────────────────────────

  /** Query. The pointer's heading in degrees about the dial center (the
   * atan2 branch, so only ever known modulo a full turn — which is exactly why
   * it is INTEGRATED rather than written). Screen coords (y down) map straight
   * onto the convention. */
  function pointerHeading(e) {
    const rect = svgEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  }

  /** Command. Integrates one step of the drag: advances the gesture's heading by
   * the SHORTEST turn from the pointer heading it last saw, and previews it. ONE
   * rule serves both the press and every move, which is what makes the dial feel
   * ABSOLUTE (a press snaps the needle to the pointer, never more than a half
   * turn away) while still ACCUMULATING turns across a long sweep — 350 → 370,
   * not 350 → 10 (the multi-turn invariant, header). A step larger than a half
   * turn between two pointer events would be read as the short way round; that
   * is inherent to every incremental rotary and needs a flick faster than the
   * pointer-event rate to provoke.
   *
   * Integrates away from `drag.pointer`, which the press seeds to the heading
   * already on screen — so the press step is "snap to the pointer by the shortest
   * arc from the current value" and every move step is "advance by the arc the
   * pointer just swept", from the one expression. */
  function integrateDrag(e) {
    const pointer = pointerHeading(e);
    const next = drag.value + shortestTurn(pointer - drag.pointer);
    drag = { value: next, pointer };
    emitPreview(next);
  }

  /** Command. Starts a dial drag (captures the pointer, previews immediately). */
  function onPointerDown(e) {
    if (disabled) return;
    svgEl.setPointerCapture(e.pointerId);
    // Seed as if the pointer had last been seen exactly at the on-screen heading.
    drag = { value: displayDeg, pointer: displayDeg };
    integrateDrag(e);
    e.preventDefault();
  }
  /** Command. Previews the swept heading; the document stays untouched. */
  function onPointerMove(e) {
    if (!drag) return;
    integrateDrag(e);
  }
  /** Command. Settles the drag as ONE undo unit, at the heading the integrator
   * accumulated (turn count included) — NOT at a re-read of the pointer, which
   * would throw the turns away. */
  function onPointerUp(e) {
    if (!drag) return;
    const settledDeg = drag.value;
    drag = null;
    svgEl.releasePointerCapture?.(e.pointerId);
    emitCommit(settledDeg);
  }

  /** Command. Arrow keys nudge the heading (accessible fine control); Shift =
   * coarse. Each nudge is its own undo unit, and never folds the heading — 359 +
   * 15 is 374, so keying past the top keeps counting turns like a drag does.
   *
   * It ALSO claims the plain keyspace while the dial has focus, exactly as
   * lib/DraggableNumber does and for the same reason (src/lib/fieldKeys.js states
   * the boundary once): the dial is an svg[role=slider], so App.svelte's
   * isTypingTarget() reports FALSE and every canvas shortcut used to fire behind it
   * — Backspace DELETED the widget whose rotation was being edited, and the arrow
   * keys nudged the heading AND changed slide from one press. Cmd/Ctrl/Alt combos
   * and Tab/Escape/Enter keep bubbling. */
  function onKeydown(e) {
    if (disabled) return;
    if (fieldOwnsKeydown(e)) e.stopPropagation();
    const step = e.shiftKey ? NUDGE_COARSE_DEG : NUDGE_STEP_DEG;
    let delta = 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
    else return;
    e.preventDefault();
    emitCommit(displayDeg + delta);
  }

  // ── The ONE text-entry path (degrees AND equations) ─────────────────────────

  /** Command. Opens the expression editor pre-filled with `seed` (the current
   * heading by default) — the seam BOTH surfacings plug into: the ƒ button and
   * a leading "=" typed into the degrees box. */
  async function beginTextEntry(seed = null) {
    textEntry = true;
    focused = true;
    draft = seed ?? String(shownDeg);
    await Promise.resolve(); // let the input render before focusing it
    eqInputEl?.focus();
    if (seed === null) eqInputEl?.select();
    else eqInputEl?.setSelectionRange(draft.length, draft.length); // caret after the typed "="
  }

  /** Command. Latches the editor OPEN for as long as it has focus. The editor
   * also shows whenever the STORED value is an equation, but that alone is not
   * enough while typing: previewing a reference-free draft ("45") makes the
   * previewed value a NUMBER, which would unmount the editor out from under the
   * caret. Editing is UI state, not a function of the value. */
  function beginEditingEquation() {
    focused = true;
    textEntry = true;
  }

  /** Command. The degrees box's keystrokes. A leading "=" PROMOTES to the
   * expression editor (so the autocomplete and highlighting come with it);
   * anything else is plain numeric typing, decided symmetrically on commit. */
  function onDegreesInput(e) {
    const text = e.target.value;
    if (EQ_MARKER.test(text)) beginTextEntry(text);
    else draft = text;
  }

  /** Command. Previews the draft as the user types. An invalid draft shows the
   * affordance ONLY — the specific message would thrash mid-keystroke; commit
   * reports it loudly if the user insists (NumericField's ruling). */
  function onEqInput(e) {
    draft = e.target.value;
    suggestionsOpen = true; // any edit re-opens/re-ranks (candidates is $derived on the caret)
    highlighted = 0;
    syncScroll();
    try {
      emitPreview(angleFromDraft(draft, app.rawState()));
      invalid = false;
    } catch {
      app.cancelPreview();
      invalid = true;
    }
  }

  /** Command. Replaces the in-progress fragment with the accepted candidate and
   * re-previews — does NOT commit the field (the user is still editing).
   * Keeps focus in the input and closes the dropdown. */
  function acceptCandidate(candidate) {
    if (!candidate || !eqInputEl) return;
    const { text, cursor } = acceptSuggestion(draft, eqInputEl.selectionStart ?? draft.length, candidate.text);
    draft = text;
    suggestionsOpen = false;
    try {
      emitPreview(angleFromDraft(draft, app.rawState()));
      invalid = false;
    } catch {
      app.cancelPreview();
      invalid = true;
    }
    // Restore the caret right after the inserted text (not end-of-field — there
    // may be more expression after it).
    requestAnimationFrame(() => eqInputEl?.setSelectionRange(cursor, cursor));
    eqInputEl.focus();
  }

  /** Command. Commits the draft as ONE undo unit; WHAT WAS TYPED decides the
   * type (angleFromDraft). A draft that cannot be committed is REPORTED and the
   * field reverts to the document's value — never a silent 0. */
  function commitText() {
    suggestionsOpen = false;
    let committed;
    try {
      committed = angleFromDraft(draft, app.rawState());
    } catch (e) {
      console.error(`PowerRP: angle not committed: ${e.message}`);
      revertDraft();
      return;
    }
    emitCommit(committed);
    invalid = false;
    endTextEntry();
  }

  /** Command. Closes the text editor and re-syncs the draft to what the document
   * now holds — so the blur that FOLLOWS an Enter sees no change and does not
   * commit a SECOND time (the one-undo-unit contract in web/app.svelte.js
   * outranks mirroring NumericField's blur path verbatim), and so a commit that
   * turned an equation back into a literal hands the degrees box a fresh value. */
  function endTextEntry() {
    textEntry = false;
    focused = false;
    draft = currentText();
  }

  /** Query. The document's own text for the current value — what an UNTOUCHED
   * draft equals, so a focus/blur with no edit commits nothing (no undo entry). */
  function currentText() {
    return isEquation ? angleDraftFromStored(stored, app.rawState()) : String(shownDeg);
  }

  /** Command. Reverts to the document's value, discarding the live preview. */
  function revertDraft() {
    app?.cancelPreview();
    invalid = false;
    endTextEntry();
  }

  /** Command. Keyboard for the ONE text-entry path, autocomplete-aware — the
   *  shared equation-suggest keyboard (web/equationSuggestKeys.js), which
   *  NumericField and the Inspector's universal `=` row wire identically. The
   *  behaviour is documented there; this is only the wiring.
   *
   *  NOTE it is attached to BOTH of this field's inputs — the equation input and
   *  the plain degrees input (only onEqInput ever sets suggestionsOpen, so on the
   *  degrees input the same handler degrades to plain Enter-commit /
   *  Escape-revert, which is exactly what that input wants). */
  const onTextKeydown = makeEquationSuggestKeydown({
    isOpen: () => suggestionsOpen,
    candidates: () => candidates,
    highlighted: () => highlighted,
    setHighlighted: (i) => (highlighted = i),
    setOpen: (open) => (suggestionsOpen = open),
    accept: acceptCandidate,
    commit: commitText,
    revert: revertDraft,
  });

  /** Command. Settles the field on blur — but ONLY if something actually
   * changed, so tabbing through a field never writes a no-op undo entry. */
  function onTextBlur() {
    focused = false;
    suggestionsOpen = false;
    if (invalid || textEntry || draft !== currentText()) commitText();
  }
</script>

<div class="numfield">
  {#if showText}
    <!-- EQUATION EDITOR — the SAME DOM NumericField renders (app.css .eq-*): a
         colorized overlay behind a transparent-text input, the evaluated/error
         badge, and the autocomplete dropdown anchored under the box. -->
    <span class="eq-wrap">
      <div class="eq-highlight" bind:this={highlightEl} aria-hidden="true">
        {#each highlightPieces as p}{#if p.cls}<span class="eq-tok eq-tok-{p.cls}">{p.text}</span>{:else}{p.text}{/if}{/each}
      </div>
      <input
        bind:this={eqInputEl}
        type="text"
        class="eq-input"
        data-hint-scope="commit"
        class:invalid
        class:error={!invalid && !!error}
        spellcheck="false"
        aria-label={`${label} equation`}
        value={draft}
        {disabled}
        oninput={onEqInput}
        onscroll={syncScroll}
        onfocus={beginEditingEquation}
        onblur={onTextBlur}
        onkeydown={onTextKeydown}
      />
      {#if !invalid && error}
        <Tooltip text={error}>
          <span class="eq-badge eq-badge-error">
            <iconify-icon icon="mdi:alert-circle-outline" width="13" height="13"></iconify-icon>
          </span>
        </Tooltip>
      {:else}
        <!-- Live evaluation, in the unit the DIAL shows — degrees, whatever the
             row stores (unit.toDisplay already applied in shownDeg). The "°" is
             literal because this field is definitionally a degrees editor, not
             because the display unit happens to suffix one. -->
        <span class="eq-badge">= {invalid ? "?" : shownDeg}°</span>
      {/if}
      <EquationSuggest
        {candidates}
        {highlighted}
        anchorEl={eqInputEl}
        onhover={(i) => (highlighted = i)}
        onpick={acceptCandidate}
      />
    </span>
  {:else}
    {#if bound}
      <!-- Equation affordance (round-11 ruling): on the LEFT of the value,
           HOVER-ONLY (revealed by .row:hover in app.css). It opens the SAME
           symmetric text-entry path a typed "=" opens — NOT a mode toggle. -->
      <Tooltip text="Enter an equation">
        <button
          class="eq-open"
          aria-label={`${label}: enter an equation`}
          {disabled}
          onclick={() => beginTextEntry()}
        >
          <iconify-icon icon="mdi:function-variant" width="14" height="14"></iconify-icon>
        </button>
      </Tooltip>
    {/if}

    <!-- THE TYPED-DEGREES BOX COMES FIRST, and the dial trails it. That ordering
         is the alignment fix, not a preference: the dial used to lead, so a
         Rotation row's first ink sat 54px (dial + gap) right of every other row's
         field edge while the row still claimed to share the value column. The box
         is now the standardized field control every other row leads with, on the
         column edge, and the dial is a trailing accessory. -->
    <span class="anglefield-degrees">
      <input
        type="text"
        class="anglefield-input"
        inputmode="numeric"
        spellcheck="false"
        aria-label={`${label} degrees`}
        value={draft}
        {disabled}
        oninput={onDegreesInput}
        onfocus={() => (focused = true)}
        onblur={onTextBlur}
        onkeydown={onTextKeydown}
      />
      <span class="anglefield-unit" aria-hidden="true">°</span>
    </span>

    <!-- The rotary dial. role=slider for a11y; drag or arrow-key to change.
         NO aria-valuemin/max: the heading is UNBOUNDED (multi-turn — see the
         header), so announcing a 0..360 range would misdescribe it; the raw
         value carries in aria-valuenow with a degree-suffixed valuetext.
         The cursor is the GRABBING (closed) hand while a drag is in flight and
         the GRAB (open) hand at rest, so the gesture reads as picking the knob
         up and putting it down. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- `angle-dial` is the class App.svelte's focus tracker classifies this
         control by, so the HintBar can announce the dial's OWN modifier (Shift =
         coarser nudge) while it is focused. role="slider" alone is not specific
         enough — lib/ColorPicker's hue/sat/alpha handles are sliders too and read
         no modifier, so keying off the role would put a false chip on the bar. -->
    <svg
      bind:this={svgEl}
      class="angle-dial"
      class:disabled
      viewBox="0 0 {VIEWBOX} {VIEWBOX}"
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={`${label} angle`}
      aria-valuenow={Math.round(displayDeg)}
      aria-valuetext={`${shownDeg}°`}
      aria-disabled={disabled}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onkeydown={onKeydown}
      style:cursor={disabled ? "default" : dragging ? "grabbing" : "grab"}
    >
      <!-- ring -->
      <circle cx={CENTER} cy={CENTER} r={RING_R} fill="none" stroke="var(--border)" stroke-width="2" />
      <!-- cardinal ticks (0/90/180/270) for orientation -->
      {#each [0, 90, 180, 270] as t}
        {@const tr = (t * Math.PI) / 180}
        <line
          x1={CENTER + TICK_INNER * Math.cos(tr)} y1={CENTER + TICK_INNER * Math.sin(tr)}
          x2={CENTER + RING_R * Math.cos(tr)} y2={CENTER + RING_R * Math.sin(tr)}
          stroke="var(--fg-dim)" stroke-width="1.5"
        />
      {/each}
      <!-- needle + knob -->
      <line x1={CENTER} y1={CENTER} x2={tipX} y2={tipY} stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
      <circle cx={tipX} cy={tipY} r={KNOB_R} fill="var(--accent)" />
      <circle cx={CENTER} cy={CENTER} r={HUB_R} fill="var(--fg-dim)" />
    </svg>
  {/if}
</div>
